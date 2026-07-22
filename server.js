// server.js
// Backend de Tapin: cuenta y registra cada toque NFC con fecha y hora exactas,
// redirige al cliente a Google, y permite exportar el historial por negocio
// (útil para cobrar la suscripción a tus clientes con datos reales).

const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
// Render pone la app detrás de un proxy que sí habla HTTPS con el navegador,
// pero le reenvía a la app en HTTP plano. Sin esta línea, req.protocol
// siempre da "http" aunque el sitio real sea https — y eso rompe cualquier
// cosa que arme una URL completa a partir de req.protocol (como el login de
// Google, que exige que el redirect_uri coincida exactamente con https).
// Limitador de intentos simple, en memoria (sin librerías ni base de datos
// aparte) — protege login de cliente, acceso de administrador, y registro
// contra alguien probando contraseñas o claves sin parar. Se resetea si el
// servidor se reinicia, lo cual es aceptable para este tamaño de proyecto.
const intentosPorIP = {};
function limitarIntentos(maxIntentos, ventanaMinutos) {
  return (req, res, next) => {
    const ip = req.ip || "desconocida";
    const clave = `${ip}:${req.path}`;
    const ahora = Date.now();
    const ventanaMs = ventanaMinutos * 60 * 1000;
    if (!intentosPorIP[clave]) intentosPorIP[clave] = [];
    intentosPorIP[clave] = intentosPorIP[clave].filter((t) => ahora - t < ventanaMs);
    if (intentosPorIP[clave].length >= maxIntentos) {
      return res.status(429).send("Demasiados intentos. Espera unos minutos e inténtalo de nuevo.");
    }
    intentosPorIP[clave].push(ahora);
    next();
  };
}
// Limpieza periódica para que este objeto no crezca sin control con el tiempo.
setInterval(() => {
  const ahora = Date.now();
  for (const clave in intentosPorIP) {
    intentosPorIP[clave] = intentosPorIP[clave].filter((t) => ahora - t < 30 * 60 * 1000);
    if (intentosPorIP[clave].length === 0) delete intentosPorIP[clave];
  }
}, 10 * 60 * 1000);

// Protege ADMIN_KEY contra fuerza bruta en TODAS las rutas de administrador
// (/stats, /editar, /codigos, /auditoria, /respaldo, etc.) — hasta ahora solo
// /admin/entrar tenía límite de intentos, pero esas otras rutas también
// aceptan ?key= directamente sin pasar por ahí. Solo cuenta intentos FALLIDOS
// (clave incorrecta) — el administrador real, con la clave correcta, nunca
// se ve afectado por esto sin importar cuántas veces recargue la página.
const intentosAdminFallidos = {};
function limitarIntentosAdmin(req, res, next) {
  if (!req.query.key || req.query.key === ADMIN_KEY) return next();
  const ip = req.ip || "desconocida";
  const ahora = Date.now();
  const ventanaMs = 15 * 60 * 1000;
  if (!intentosAdminFallidos[ip]) intentosAdminFallidos[ip] = [];
  intentosAdminFallidos[ip] = intentosAdminFallidos[ip].filter((t) => ahora - t < ventanaMs);
  if (intentosAdminFallidos[ip].length >= 10) {
    return res.status(429).send("Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.");
  }
  intentosAdminFallidos[ip].push(ahora);
  next();
}
setInterval(() => {
  const ahora = Date.now();
  for (const ip in intentosAdminFallidos) {
    intentosAdminFallidos[ip] = intentosAdminFallidos[ip].filter((t) => ahora - t < 30 * 60 * 1000);
    if (intentosAdminFallidos[ip].length === 0) delete intentosAdminFallidos[ip];
  }
}, 10 * 60 * 1000);

app.set("trust proxy", 1);

// Encabezados de seguridad básicos en cada respuesta — sin librerías extra.
// No cambian nada visual ni de comportamiento, solo le dicen al navegador
// que sea más estricto (no dejar que Tapin se cargue dentro de un iframe
// ajeno, no adivinar tipos de archivo, etc.).
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Selector de tema disponible en todas las páginas HTML. Solo cambia la
// apariencia y recuerda la preferencia en el navegador; no altera datos,
// sesiones, rutas ni la lógica de negocio.
const CONTROL_TEMA_GLOBAL = `
  <style>
    #tapin-theme-toggle{position:fixed;right:16px;bottom:16px;z-index:99999;width:48px;height:48px;border:1px solid rgba(255,255,255,.45);border-radius:50%;padding:0;background:#0d432b;color:#fff;font:700 21px/1 'Segoe UI Emoji','Segoe UI',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.28);cursor:pointer;display:flex;align-items:center;justify-content:center;}
    #tapin-theme-toggle:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(0,0,0,.34);}
    body .tabla-pro th:first-child,body .tabla-pro td:first-child{text-align:center!important;}
    body .tabla-pro td{padding-top:12px!important;padding-bottom:12px!important;}
    body .precios-grid{align-items:stretch!important;}
    body .precios-grid>.precio-card{display:flex!important;flex-direction:column!important;height:auto!important;}
    body .precios-grid>.precio-card>.tabla-precios{flex:1;}
    body .tabla-pro tr:not(:first-child):hover td{filter:brightness(.97);}
    body .tabla-pro tr.fila-empresa td{background:#fbf1d8!important;color:#624a08!important;font-weight:800!important;border-top:2px solid #e8ad32!important;}
    html.tapin-dark{color-scheme:dark;--ink:#f4faf6;--forest:#438b67;--forest2:#256448;--cream:#071f16;--paper:#1b5139;--muted:#d0e0d6;--line:#5c8a70;--gold:#e8ad32;--gold2:#f7d77d;}
    html.tapin-dark body{background:#071f16!important;color:#f4faf6!important;}
    html.tapin-dark body :is(.site-header,.box,.card,.seccion,.form-card,.chart-card,.metric,.plan,.flujo,.precio-card,.nota,.tarjeta-info,.reco,.faq-item,table){background:#1b5139!important;color:#f4faf6!important;border:1px solid #5c8a70!important;box-shadow:0 14px 30px rgba(0,0,0,.34);}
    html.tapin-dark body :is(.paso,.chart-card .reco,.form-card input,.form-card select,.form-card textarea){background:#0f3525!important;border-color:#46745b!important;box-shadow:0 7px 16px rgba(0,0,0,.2);}
    html.tapin-dark body :is(h1,h2,h3,h4,.card-titulo,.seccion-titulo,.titulo-pagina){color:#f4faf6!important;}
    html.tapin-dark body :is(p,.nota,.subtitulo,.seccion-sub,.flujo-descripcion,.paso p,.acceso p,td,th,label,.metric-lbl){color:#c2d1c7!important;}
    html.tapin-dark body :is(input,select,textarea){background:#0d2b1e!important;color:#f4faf6!important;border-color:#668f78!important;}
    html.tapin-dark body :is(input,textarea)::placeholder{color:#8fa598!important;}
    html.tapin-dark body :is(td,th){background:#1b5139!important;}
    html.tapin-dark body .tabla-precios tr:nth-child(even) td{background:#103625!important;}
    html.tapin-dark body .tabla-precios tr:last-child td{background:#2a684a!important;color:#fff!important;}
    html.tapin-dark body .tabla-pro tr.fila-empresa td{background:#f3efe3!important;color:#163a2a!important;border-top-color:#e8ad32!important;}
    html.tapin-dark body .paso-num{background:#294637!important;color:#fff!important;}
    html.tapin-dark body .metric-num{background:transparent!important;color:#fff!important;box-shadow:none!important;}
    html.tapin-dark body :is(.check,.eyebrow){color:#ffdc7a!important;}
    html.tapin-dark body :is(.topbar,.site-order){background:#0b2a1d!important;color:#fff!important;}
    html.tapin-dark body .hero{background:linear-gradient(145deg,#347e5b 0%,#286f4f 48%,#205b41 100%)!important;color:#fff!important;}
    html.tapin-dark body :is(.hero,.topbar,.site-order) *{color:#fff!important;}
    html.tapin-dark body :is(.hero-cta-main,.plan-anual,.plan-anual-badge,.plan-badge,.acceso-badge){background:#f0b83e!important;color:#062e1e!important;}
    html.tapin-dark body :is(.hero-cta-main,.plan-anual,.plan-anual-badge,.plan-badge,.acceso-badge) *{color:#062e1e!important;}
    html.tapin-dark body .paso-pro-badge{background:#2f7655!important;color:#fff!important;}
    html.tapin-dark body .acceso{border:1px solid #6b957e!important;box-shadow:0 14px 30px rgba(0,0,0,.34);}
    html.tapin-dark body .acceso-1{background:linear-gradient(135deg,#0d3b29,#236346)!important;color:#fff!important;}
    html.tapin-dark body .acceso-3{background:#dbe8df!important;color:#0b3424!important;border-color:#a9c2b3!important;}
    html.tapin-dark body .acceso-3 :is(h3,p,span,div){color:#0b3424!important;}
    html.tapin-dark body .acceso-4{background:linear-gradient(135deg,#ffdc7a,#f0b83e)!important;color:#062e1e!important;}
    html.tapin-dark body .acceso-4 :is(h3,p,span){color:#062e1e!important;}
    html.tapin-dark body .flujo-pro{background:linear-gradient(135deg,#1b5139,#46391e)!important;border:2px solid #e8ad32!important;}
    html.tapin-dark body :is(.site-brand,.logo,.topbar>div:first-child) svg [fill]{fill:#fff!important;}
    html.tapin-dark body :is(.site-brand,.logo,.topbar>div:first-child) svg [stroke]{stroke:#fff!important;}
    html.tapin-dark body .tarjeta-nfc{background:#fff!important;}
    html.tapin-dark body .tarjeta-nfc *{color:#062e1e!important;}
    html.tapin-dark body .tarjeta-google span:nth-child(1),html.tapin-dark body .tarjeta-google span:nth-child(4){color:#4285F4!important;}
    html.tapin-dark body .tarjeta-google span:nth-child(2),html.tapin-dark body .tarjeta-google span:nth-child(6){color:#EA4335!important;}
    html.tapin-dark body .tarjeta-google span:nth-child(3){color:#FBBC05!important;}
    html.tapin-dark body .tarjeta-google span:nth-child(5){color:#34A853!important;}
    html.tapin-dark body a{color:#ffdc7a;}
    html.tapin-dark body .google-login{background:#fff!important;color:#27312b!important;border-color:#d7ddd9!important;box-shadow:none!important;}
    html.tapin-dark body .google-login svg path{border-color:transparent!important;}
    html.tapin-dark #tapin-theme-toggle{background:#ffdc7a;color:#062e1e;border-color:#f0b83e;}
    html.tapin-dark body[data-tapin-page="principal"] :is(#como-funciona,#precios){background:rgba(27,81,57,.62)!important;border:1px solid #5c8a70!important;}
    html.tapin-dark body[data-tapin-page="principal"] :is(#accesos,#preguntas){background:rgba(8,43,29,.72)!important;border:1px solid #416c55!important;}
    html.tapin-dark body[data-tapin-page="admin"],html.tapin-dark body[data-tapin-page="negocio"]{background:#071f16!important;}
    html.tapin-dark body[data-tapin-page="admin"] :is(.content,.contenido),html.tapin-dark body[data-tapin-page="negocio"] :is(.content,.contenido){background:transparent!important;}
    html.tapin-dark body[data-tapin-page="admin"] :is(button[type="submit"],.btn),html.tapin-dark body[data-tapin-page="negocio"] :is(button[type="submit"],.btn){background:#f3efe3!important;color:#163a2a!important;border-color:#d8cfba!important;}
    html.tapin-dark body[data-tapin-page="admin"] :is(button[type="submit"],.btn) *,html.tapin-dark body[data-tapin-page="negocio"] :is(button[type="submit"],.btn) *{color:#163a2a!important;}
    html.tapin-dark body :is(.ver-clave,.icono-toggle){background:transparent!important;color:#d6e4db!important;border:none!important;box-shadow:none!important;transform:none!important;}
    html.tapin-dark body .ver-clave{position:absolute!important;right:4px!important;top:4px!important;bottom:4px!important;width:36px!important;height:auto!important;padding:0!important;margin:0!important;border-radius:7px!important;}
    html.tapin-dark body[data-tapin-page="admin"] .seccion,html.tapin-dark body[data-tapin-page="negocio"] .seccion{background:transparent!important;border:none!important;box-shadow:none!important;}
    html.tapin-dark body[data-tapin-page="admin"] :is(.resumen-box,.negocio-card,.pais-card,.chart-card),html.tapin-dark body[data-tapin-page="negocio"] :is(.resumen-box,.negocio-card,.chart-card){background:#123a29!important;color:#f4faf6!important;border:1px solid #4f7d64!important;box-shadow:0 8px 20px rgba(0,0,0,.22)!important;}
    html.tapin-dark body[data-tapin-page="admin"] :is(.resumen-num,.resumen-lbl,.card-total,.card-total span),html.tapin-dark body[data-tapin-page="negocio"] :is(.resumen-num,.resumen-lbl,.card-total,.card-total span){color:#f4faf6!important;}
    html.tapin-dark body :is(.spark-bar,.hora-barra){background:#62c28d!important;box-shadow:0 0 0 1px rgba(255,255,255,.08);}
    html.tapin-dark body[data-tapin-page="admin"] .sparkline>div>div:not(.spark-bar),html.tapin-dark body[data-tapin-page="negocio"] .sparkline>div>div:not(.spark-bar){color:#e6f1ea!important;}
    html.tapin-dark body[data-tapin-page="negocio"] :is(.tabla-actividad,table){border:1px solid #72a088!important;background:#0d3021!important;}
    html.tapin-dark body[data-tapin-page="negocio"] :is(.tabla-actividad,table) th{background:#164631!important;color:#fff!important;border-color:#72a088!important;}
    html.tapin-dark body[data-tapin-page="negocio"] :is(.tabla-actividad,table) td{background:#1b5139!important;color:#f4faf6!important;border-color:#72a088!important;}
    html.tapin-dark body[data-tapin-page="negocio"] :is(.tabla-actividad,table) tr:nth-child(even) td{background:#15442f!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .chart-card .tabla-actividad{background:transparent!important;border:none!important;border-radius:0!important;box-shadow:none!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .seccion-actividad{margin-top:38px!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .seccion-actividad>.card-titulo{margin-bottom:14px!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .chart-card :is(div,span,p){color:#dcebe1!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .chart-card :is(b,strong){color:#fff!important;}
    html.tapin-dark body[data-tapin-page="negocio"] :is(.btn-herramienta,.panel-acciones a),html.tapin-dark body[data-tapin-page="admin"] :is(.card-actions a,.btn-pais){background:#f3efe3!important;color:#163a2a!important;border:1px solid #d8cfba!important;box-shadow:0 5px 12px rgba(0,0,0,.18)!important;}
    html.tapin-dark body[data-tapin-page="negocio"] :is(.btn-herramienta,.panel-acciones a):hover,html.tapin-dark body[data-tapin-page="admin"] :is(.card-actions a,.btn-pais):hover{background:#fffaf0!important;color:#0b2f20!important;border-color:#e8ad32!important;}
    html.tapin-dark body[data-tapin-page="admin"] .sector-badge,html.tapin-dark body[data-tapin-page="negocio"] .sector-badge{color:#8ce3b2!important;}
    html.tapin-dark body[data-tapin-page="admin"] .ultimo-toque,html.tapin-dark body[data-tapin-page="negocio"] .ultimo-toque{color:#cfe1d6!important;}
    html.tapin-dark body[data-tapin-page="admin"] .ultimo-toque b,html.tapin-dark body[data-tapin-page="negocio"] .ultimo-toque b{color:#fff!important;}
    html.tapin-dark body[data-tapin-page="admin"] .card-ultimo{color:#cfe1d6!important;border-top-color:#72a088!important;}
    html.tapin-dark body[data-tapin-page="admin"] .card-ultimo b{color:#fff!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .cal-dia.cal-vacio{color:#173b2b!important;background:#dedbcd!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .cal-dia.cal-activo{color:#fff!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .cal-dia.cal-nivel-1{background:#78d7a1!important;color:#092719!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .cal-dia.cal-nivel-2{background:#4caf78!important;color:#092719!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .cal-dia.cal-nivel-3{background:#34875d!important;color:#fff!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .cal-dia.cal-nivel-4{background:#174f36!important;color:#fff!important;}
    html.tapin-dark body[data-tapin-page="negocio"] .cal-leyenda{color:#cfe1d6!important;}
    html.tapin-dark body[data-tapin-page="descubre"] #mapa *{border-color:initial!important;}
    html.tapin-dark body[data-tapin-page="descubre"] :is(.chip-cat,.leyenda,.vacio,.leaflet-popup-content-wrapper,.leaflet-popup-tip,.leaflet-control-zoom a,.leaflet-control-attribution){background:#17432f!important;color:#f4faf6!important;border-color:#5c8a70!important;}
    html.tapin-dark body[data-tapin-page="descubre"] :is(.chip-cat,.leyenda,.vacio,.leaflet-popup-content-wrapper,.leaflet-control-zoom a,.leaflet-control-attribution) *{color:#f4faf6!important;}
    html.tapin-dark body[data-tapin-page="descubre"] .chip-cat.activo{background:#e8ad32!important;color:#062e1e!important;border-color:#f7d77d!important;}
    html.tapin-dark body[data-tapin-page="descubre"] .chip-cat.activo *{color:#062e1e!important;}
    html.tapin-dark body[data-tapin-page="descubre"] :is(.popup-link,.popup-fav.activo){background:#e8ad32!important;color:#062e1e!important;}
  </style>
  <button id="tapin-theme-toggle" type="button" aria-label="Activar tema oscuro" title="Activar tema oscuro">🌙</button>
  <script>
    (() => {
      const raiz = document.documentElement;
      const boton = document.getElementById("tapin-theme-toggle");
      let oscuro = false;
      try { oscuro = localStorage.getItem("tapin-tema") === "oscuro"; } catch (_) {}
      const aplicar = () => {
        raiz.classList.toggle("tapin-dark", oscuro);
        boton.textContent = oscuro ? "☀️" : "🌙";
        const descripcion = oscuro ? "Activar tema claro" : "Activar tema oscuro";
        boton.setAttribute("aria-label", descripcion);
        boton.setAttribute("title", descripcion);
      };
      aplicar();
      boton.addEventListener("click", () => {
        oscuro = !oscuro;
        aplicar();
        try { localStorage.setItem("tapin-tema", oscuro ? "oscuro" : "claro"); } catch (_) {}
      });
    })();
  </script>`;

app.use((req, res, next) => {
  const enviar = res.send.bind(res);
  res.send = (contenido) => {
    if (typeof contenido === "string" && /<\/body>/i.test(contenido) && !contenido.includes('id="tapin-theme-toggle"')) {
      let pagina = "general";
      if (req.path === "/") pagina = "principal";
      else if (req.path === "/descubre") pagina = "descubre";
      else if (/^\/(mi-panel|mis-negocios)(\/|$)/.test(req.path) || /^\/editar\/[^/]+/.test(req.path)) pagina = "negocio";
      else if (/^\/(admin|stats|editar|codigos|auditoria|respaldo)(\/|$)/.test(req.path)) pagina = "admin";
      contenido = contenido.replace(/<body([^>]*)>/i, `<body$1 data-tapin-page="${pagina}">`);
      // El panel de negocio (mi-panel / mis-negocios) no lleva el botón de
      // modo oscuro -- se quitó a pedido. El resto del sitio lo conserva.
      const esPanelDeNegocio = /^\/(mi-panel|mis-negocios)(\/|$)/.test(req.path);
      if (!esPanelDeNegocio) {
        contenido = contenido.replace(/<\/body>/i, `${CONTROL_TEMA_GLOBAL}</body>`);
      }
    }
    return enviar(contenido);
  };
  next();
});

// tapin.page se redirige automáticamente a tapincol.com (el dominio nuevo y
// principal de aquí en adelante) — así las tarjetas físicas grabadas con
// tapin.page siguen funcionando para siempre, y todo el tráfico nuevo, SEO
// y enlaces se consolidan en tapincol.com. Redirect 301 (permanente) — es
// la señal correcta para que Google entienda que el sitio se mudó y
// traslade el posicionamiento acumulado al dominio nuevo.
app.use((req, res, next) => {
  const host = (req.get("host") || "").toLowerCase();
  if (host === "tapin.page" || host === "www.tapin.page") {
    return res.redirect(301, `https://tapincol.com${req.originalUrl}`);
  }
  next();
});

const PORT = process.env.PORT || 3000;

// ---------- IMPORTANTE: almacenamiento persistente ----------
// Todos los archivos .json que usa este backend como "base de datos" (toques,
// negocios activados, clientes, pedidos) se guardan en DATA_DIR. Por defecto
// apunta a la misma carpeta del código (__dirname), lo cual funciona bien en
// tu computador — PERO en Render, la carpeta del código se reconstruye desde
// cero cada vez que subes código nuevo, así que cualquier archivo guardado ahí
// se BORRA en cada redeploy.
//
// Para que los datos sobrevivan entre redeploys en Render, crea un "Persistent
// Disk" en tu servicio (Settings → Disks → Add Disk), móntalo por ejemplo en
// /var/data, y agrega la variable de entorno DATA_DIR=/var/data. A partir de
// ahí, todo lo que se guarde (negocios, planes, clientes, pedidos) sobrevive
// sin importar cuántas veces redespliegues.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");

// ---------- Envío de correos (alertas, reportes mensuales, etc.) ----------
// Funciona con cualquier SMTP. Para Gmail: activa verificación en 2 pasos en la
// cuenta y genera una "contraseña de aplicación" (myaccount.google.com/apppasswords),
// esa es la que va en EMAIL_PASS (NO tu contraseña normal de Gmail).
// Variables de entorno necesarias en Render: EMAIL_USER, EMAIL_PASS.
let transportadorEmail = null;
function obtenerTransportador() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return null;
  if (!transportadorEmail) {
    const puerto = parseInt(process.env.EMAIL_PORT, 10) || 465;
    transportadorEmail = nodemailer.createTransport({
      host: process.env.EMAIL_HOST || "smtp.gmail.com",
      port: puerto,
      // BUG CORREGIDO: antes esto era siempre "true", lo cual rompe la conexión
      // si alguien configura EMAIL_PORT=587 (Gmail con STARTTLS en vez de SSL directo).
      // El puerto 465 usa SSL directo (secure:true); el 587 usa STARTTLS (secure:false).
      secure: puerto === 465,
      connectionTimeout: 10000, // 10s — si Render bloquea el puerto saliente, falla rápido en vez de colgarse
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
  }
  return transportadorEmail;
}

async function enviarEmail(destinatario, asunto, html, adjuntos = []) {
  if (!destinatario) {
    console.log(`[email no enviado — falta destinatario] asunto: ${asunto}`);
    return { ok: false, motivo: "El negocio no tiene 'email' configurado." };
  }

  // Si hay SENDGRID_API_KEY configurada, se usa esa primero — mejor
  // entregabilidad (menos probabilidad de caer en spam) que el SMTP básico.
  // Si no está configurada, cae solo al método anterior (Gmail/SMTP), sin
  // romper nada de lo que ya funcionaba.
  if (process.env.SENDGRID_API_KEY) {
    try {
      const attachments = adjuntos.map((a) => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(a.content).toString("base64"),
        type: a.filename.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
        disposition: "attachment",
      }));
      const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: destinatario }] }],
          from: { email: process.env.SENDGRID_FROM || process.env.EMAIL_USER, name: "Tapin" },
          subject: asunto,
          content: [{ type: "text/html", value: html }],
          ...(attachments.length ? { attachments } : {}),
        }),
      });
      if (resp.ok || resp.status === 202) {
        console.log(`[email enviado con SendGrid] a ${destinatario} — "${asunto}"`);
        return { ok: true };
      }
      const errorTexto = await resp.text();
      console.error(`[error SendGrid] a ${destinatario}:`, resp.status, errorTexto);
      // sigue abajo e intenta con SMTP como respaldo, en vez de fallar directo
    } catch (err) {
      console.error("[error SendGrid — intentando SMTP como respaldo]:", err.message);
    }
  }

  const transportador = obtenerTransportador();
  if (!transportador) {
    console.log(`[email no enviado — falta config] asunto: ${asunto}`);
    return { ok: false, motivo: "Falta EMAIL_USER/EMAIL_PASS o SENDGRID_API_KEY en el servidor." };
  }
  try {
    await transportador.sendMail({
      from: `"Tapin" <${process.env.EMAIL_USER}>`,
      to: destinatario,
      subject: asunto,
      html,
      attachments: adjuntos, // [{ filename, content }] — usado para adjuntar el PDF del reporte mensual
    });
    console.log(`[email enviado] a ${destinatario} — "${asunto}"`);
    return { ok: true };
  } catch (err) {
    // Log completo en la consola de Render para poder diagnosticar (antes solo
    // se veía "Error enviando email" sin detalle suficiente para saber la causa real).
    console.error(`[error enviando email] a ${destinatario} — "${asunto}":`, err.message, err.code || "");
    return { ok: false, motivo: err.message };
  }
}

// Clave simple para proteger /stats, /historial y /export (cámbiala por la tuya)
const ADMIN_KEY = process.env.ADMIN_KEY || "cambia-esta-clave";

// Zona horaria de Colombia para mostrar fecha/hora legibles
// Zonas horarias soportadas por país. Cada negocio guarda cuál le corresponde
// en su campo "zonaHoraria" — así los reportes muestran la hora local correcta
// sin importar en qué país esté el negocio.
const ZONAS_HORARIAS = {
  colombia: "America/Bogota",
  panama: "America/Panama",
  paraguay: "America/Asuncion",
  miami: "America/New_York", // Miami / Este de EE.UU.
};
const TIMEZONE_DEFAULT = ZONAS_HORARIAS.colombia;

function zonaDe(negocio) {
  return (negocio && ZONAS_HORARIAS[negocio.pais]) || TIMEZONE_DEFAULT;
}

// ---------- Marca Tapin ----------
// Logo de Tapin como vector real, trazado directamente del archivo de marca
// oficial (marca mixta) que Samuel subió, a resolución alta (945x945) — no
// una aproximación ni una reconstrucción con una tipografía parecida. Se ve
// nítido en cualquier tamaño y pantalla, y admite cualquier color.
const LOGO_ANCHO_VB = 1152.776120;
const LOGO_ALTO_VB = 434.961655;
const LOGO_PATH_DATA = `<path d="M504 4761 c-48 -29 -59 -69 -59 -211 1 -145 21 -211 72 -231 19 -8
188 -13 523 -16 436 -4 499 -7 530 -21 53 -26 63 -56 53 -165 -5 -50 -9 -659
-8 -1352 0 -1198 1 -1262 18 -1293 27 -49 63 -59 227 -66 162 -7 200 1 234 47
l21 28 -3 1292 c-3 857 -7 1304 -14 1329 -6 20 -31 62 -57 94 -68 84 -67 82
-54 95 9 9 165 11 600 10 388 -1 598 2 619 9 58 19 64 41 64 220 0 172 -7 203
-52 234 -20 14 -163 16 -1353 16 -1284 0 -1331 -1 -1361 -19z"/>
<path d="M8938 4767 c-67 -19 -109 -56 -148 -128 -30 -57 -33 -70 -32 -148 0
-107 20 -158 78 -210 83 -73 199 -99 297 -65 59 20 129 96 151 162 25 77 31
171 13 214 -20 49 -101 135 -150 159 -49 25 -148 33 -209 16z"/>
<path d="M4010 3850 c-188 -20 -183 -18 -310 -73 -166 -71 -301 -172 -457
-342 -206 -224 -263 -367 -308 -765 -3 -30 -1 -98 5 -150 6 -52 15 -135 20
-185 9 -94 26 -140 123 -334 36 -72 63 -105 192 -238 162 -168 251 -235 403
-305 102 -47 170 -63 344 -83 246 -27 332 -19 538 52 149 52 189 73 269 145
41 36 63 48 87 48 41 0 52 -15 70 -92 17 -70 49 -112 98 -127 17 -6 94 -9 172
-8 153 3 188 13 200 61 11 44 -2 1255 -15 1371 -22 207 -57 304 -172 480 -64
100 -261 301 -353 362 -178 118 -467 205 -667 202 -41 -1 -148 -9 -239 -19z
m363 -449 c152 -28 231 -68 330 -168 100 -102 156 -178 205 -277 46 -92 55
-122 82 -273 25 -134 25 -155 -1 -267 -25 -106 -36 -130 -122 -263 -114 -175
-235 -266 -421 -313 -87 -22 -214 -25 -393 -11 -93 8 -109 13 -180 51 -219
117 -361 277 -415 465 -20 70 -22 103 -22 265 0 213 5 238 85 404 44 92 61
115 127 177 108 101 141 123 250 166 171 66 290 77 475 44z"/>
<path d="M10810 3859 c-84 -12 -128 -24 -215 -59 -44 -18 -100 -40 -125 -49
-25 -10 -81 -45 -125 -78 -44 -34 -89 -64 -101 -67 -38 -11 -55 14 -64 93 -12
113 -17 115 -201 119 -167 4 -184 -1 -216 -61 -17 -30 -18 -102 -21 -1142 -2
-610 -1 -1124 3 -1141 10 -58 41 -69 205 -72 164 -4 210 6 244 51 20 27 21 43
27 445 11 689 20 951 35 1022 21 92 97 246 147 298 49 51 208 143 287 167 72
22 311 32 377 16 57 -15 226 -125 276 -180 20 -22 52 -71 70 -108 19 -37 45
-88 58 -113 l24 -45 0 -730 c0 -687 1 -732 18 -763 29 -52 63 -61 229 -59 161
3 183 10 215 70 17 30 18 81 15 807 l-4 775 -62 150 c-35 83 -69 166 -76 185
-19 50 -90 147 -152 207 -104 100 -321 215 -478 253 -91 21 -278 26 -390 9z"/>
<path d="M6870 3846 c-102 -24 -245 -77 -320 -120 -41 -24 -85 -46 -98 -50
-23 -8 -147 -102 -210 -160 -19 -17 -70 -75 -114 -130 -62 -76 -95 -129 -143
-230 -72 -152 -95 -214 -95 -259 0 -18 -9 -104 -20 -191 -19 -150 -20 -222
-20 -1160 0 -933 1 -1003 18 -1035 34 -67 56 -75 216 -79 118 -4 150 -1 178
12 63 30 62 18 65 605 3 534 3 535 25 558 36 39 71 31 157 -35 25 -19 75 -48
111 -65 36 -16 88 -39 115 -52 28 -12 100 -38 160 -58 110 -35 111 -35 260
-31 161 4 203 10 335 48 248 71 280 83 328 123 26 22 88 67 138 101 118 79
219 204 322 397 83 156 102 220 127 421 17 136 17 147 1 250 -10 60 -24 147
-31 194 -16 102 -27 134 -93 267 -77 154 -215 330 -327 416 -172 132 -220 159
-390 217 l-160 55 -240 2 c-167 1 -257 -2 -295 -11z m377 -427 c164 -22 370
-130 459 -241 81 -101 159 -248 186 -353 34 -133 32 -294 -5 -430 -31 -111
-56 -160 -147 -287 -71 -100 -130 -145 -257 -198 -244 -102 -331 -116 -508
-81 -127 25 -183 49 -299 124 -88 58 -122 97 -229 258 -80 122 -92 172 -91
384 0 154 3 177 26 246 52 156 189 365 281 427 202 136 372 180 584 151z"/>
<path d="M8860 3833 c-25 -9 -52 -36 -62 -63 -6 -16 -11 -439 -13 -1140 -3
-1221 -6 -1162 57 -1200 29 -18 50 -20 186 -20 122 0 161 3 188 16 69 33 65
-46 62 1208 -3 1118 -3 1134 -23 1156 -37 42 -74 50 -232 49 -81 0 -155 -3
-163 -6z"/>`;

function logoSvg(color, height) {
  const ancho = Math.round(height * (LOGO_ANCHO_VB / LOGO_ALTO_VB));
  return `<svg width="${ancho}" height="${height}" viewBox="0 0 ${LOGO_ANCHO_VB} ${LOGO_ALTO_VB}" xmlns="http://www.w3.org/2000/svg" style="display:block;">
    <g transform="translate(-44.532706,477.996311) scale(0.100000,-0.100000)" fill="${color}" stroke="none">
      ${LOGO_PATH_DATA}
    </g>
  </svg>`;
}

// Paleta de marca (extraída del logo oficial de Tapin)
const MARCA = {
  verdeOscuro: "#0d432b",
  verde: "#146542",
  verdeClaro: "#edf1ed",
  crema: "#fbf6e9",
  texto: "#062e1e",
  textoSuave: "#50695b",
  borde: "#dedccc",
  rojo: "#C0392B",
  oro: "#e8a623",
};

// Estilos base compartidos por todas las páginas del panel — look "pro" consistente.
// Íconos de "mostrar/ocultar contraseña", reutilizados en los formularios de
// login/registro de cliente y en el acceso de administrador.
const ICONO_OJO_ABIERTO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 12C1 12 5 4 12 4C19 4 23 12 23 12C23 12 19 20 12 20C5 20 1 12 1 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.8"/></svg>`;
const ICONO_OJO_CERRADO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3L21 21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10.6 5.2C11.05 5.1 11.51 5 12 5C19 5 23 12 23 12C23 12 21.8 14.2 19.6 16.1M6.9 6.9C3.7 8.9 1 12 1 12C1 12 5 19 12 19C13.6 19 15 18.6 16.2 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.9 9.9C9.34 10.46 9 11.19 9 12C9 13.66 10.34 15 12 15C12.81 15 13.54 14.66 14.1 14.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

const ESTILO_BASE = `
  *{box-sizing:border-box;}
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600;1,700&display=swap');
  :root{--ink:#062e1e;--forest:#0d432b;--forest2:#146542;--cream:#fbf6e9;--paper:#fffefd;--muted:#50695b;--line:#dedccc;--gold:#e8a623;--gold2:#f3d576;}
  body{font-family:'DM Sans','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.crema};color:${MARCA.texto};margin:0;min-height:100vh;line-height:1.5;}
  a{color:${MARCA.verde};}
  .topbar{background:linear-gradient(155deg,var(--forest2) 0%,var(--forest) 55%,#082c1c 100%);padding:20px max(24px,calc((100vw - 1140px)/2));display:flex;align-items:center;justify-content:space-between;box-shadow:0 4px 20px rgba(4,41,25,.15);position:relative;}
  .topbar .back{color:#CFE3D8;font-size:0.82rem;font-weight:500;text-decoration:none;}
  .topbar .back:hover{color:#fff;}
  .content{padding:52px 32px 76px;max-width:1140px;margin:0 auto;}
  .eyebrow{font-size:0.72rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;}
  .titulo-pagina{font-family:'Playfair Display',Georgia,serif;font-size:clamp(1.9rem,3vw,2.7rem);font-weight:700;margin:0 0 8px;letter-spacing:-.03em;color:var(--ink);}
  .subtitulo{color:${MARCA.textoSuave};font-size:0.92rem;margin-bottom:30px;}
  /* ---------- Sistema de botones reutilizable ---------- */
  button,.btn{font-family:'DM Sans','Segoe UI',sans-serif;cursor:pointer;
              transition:transform .15s ease,box-shadow .15s ease,background-color .15s ease,border-color .15s ease,opacity .15s ease;}
  button:hover,.btn:hover{transform:translateY(-2px);box-shadow:0 10px 20px rgba(5,58,36,.14);}
  button:active,.btn:active{transform:translateY(0);box-shadow:0 3px 8px rgba(5,58,36,.12);}
  button:disabled,.btn:disabled,.btn[aria-disabled="true"]{opacity:.55;cursor:not-allowed;pointer-events:none;
                                                            transform:none!important;box-shadow:none!important;}

  .btn-primario{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:${MARCA.verdeOscuro};
                color:#fff;border:none;border-radius:9px;padding:12px 22px;font-weight:700;font-size:0.88rem;
                text-decoration:none;line-height:1.2;}
  .btn-primario:hover{background:${MARCA.verde};}
  .btn-secundario{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:#fff;
                  color:${MARCA.texto};border:1.5px solid ${MARCA.borde};border-radius:9px;padding:12px 22px;
                  font-weight:700;font-size:0.88rem;text-decoration:none;line-height:1.2;}
  .btn-secundario:hover{background:${MARCA.verdeClaro};border-color:${MARCA.verde};}
  .btn-peligro{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:#fff;
               color:#a83a2b;border:1.5px solid #f0d0c8;border-radius:9px;padding:12px 22px;
               font-weight:700;font-size:0.88rem;text-decoration:none;line-height:1.2;}
  .btn-peligro:hover{background:#FDF2F1;border-color:#a83a2b;}
  .btn-ghost{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:transparent;
             color:${MARCA.verdeOscuro};border:none;padding:8px 10px;font-weight:600;font-size:0.85rem;
             text-decoration:none;border-radius:7px;}
  .btn-ghost:hover{background:rgba(13,67,43,.07);}

  /* ---------- Foco visible (navegación con teclado) ---------- */
  a:focus-visible,button:focus-visible,.btn:focus-visible,[tabindex]:focus-visible{
    outline:3px solid ${MARCA.oro};outline-offset:2px;border-radius:4px;
  }
  input:focus,select:focus,textarea:focus{outline:none;border-color:${MARCA.verde}!important;box-shadow:0 0 0 3px rgba(15,81,50,.12);}
  h1,h2,h3{font-family:'Playfair Display',Georgia,serif;}
`;

// Estilo compartido del layout tipo dashboard (sidebar + contenido) usado por
// el panel del negocio (/mi-panel) y el panel de administrador (/stats).
// Tratamiento deliberadamente "serio": tipografía de palo seco, fondo gris
// neutro, tarjetas planas con poco radio -- look de software de gestion, no
// de landing page.
const ESTILO_DASHBOARD = `
  html,body{height:100%;}
  body{background:#F5F6F8;font-family:'Inter','DM Sans','Segoe UI',-apple-system,Arial,sans-serif;}
  h1,h2,h3{font-family:'Inter','DM Sans','Segoe UI',-apple-system,Arial,sans-serif;letter-spacing:-.01em;}
  .dashboard-layout{display:flex;min-height:100vh;align-items:stretch;}
  .sidebar{width:236px;flex-shrink:0;background:${MARCA.verdeOscuro};
           color:#fff;display:flex;flex-direction:column;padding:26px 18px;box-sizing:border-box;position:sticky;top:0;height:100vh;}
  .sidebar-logo{padding:0 8px;margin-bottom:34px;}
  .sidebar-nav{display:flex;flex-direction:column;gap:2px;flex:1;}
  .sidebar-nav a{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:8px;
                 color:#C7D9CE;text-decoration:none;font-size:0.85rem;font-weight:500;transition:background .15s,color .15s;}
  .sidebar-nav a:hover{background:rgba(255,255,255,0.07);color:#fff;}
  .sidebar-nav a.activo{background:rgba(255,255,255,0.12);color:#fff;font-weight:600;}
  .sidebar-nav a svg{flex-shrink:0;width:17px;height:17px;}
  .sidebar-nav a.deshabilitado{opacity:0.4;pointer-events:none;}
  .sidebar-pie{border-top:1px solid rgba(255,255,255,0.12);padding-top:14px;margin-top:14px;}
  .sidebar-pie a{display:inline-flex;align-items:center;gap:8px;padding:7px 9px;border-radius:8px;
                 color:#C7D9CE;text-decoration:none;font-size:0.7rem;font-weight:600;}
  .sidebar-pie a svg{flex-shrink:0;width:14px;height:14px;}
  .sidebar-pie a:hover{background:rgba(255,255,255,0.07);color:#fff;}
  .dashboard-main{flex:1;min-width:0;padding:34px 40px 60px;box-sizing:border-box;}
  @media (max-width:900px){
    .dashboard-layout{flex-direction:column;}
    .sidebar{width:100%;height:auto;position:relative;flex-direction:row;align-items:center;
             overflow-x:auto;padding:14px 16px;gap:8px;}
    .sidebar-logo{margin-bottom:0;}
    .sidebar-nav{flex-direction:row;flex:none;}
    .sidebar-nav a{padding:8px 12px;white-space:nowrap;}
    .sidebar-pie{border-top:none;margin-top:0;padding-top:0;}
    .sidebar-pie a{padding:8px 12px;white-space:nowrap;}
    .dashboard-main{padding:22px 16px 50px;}
  }

  .dash-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap;}
  .dash-header h1{font-family:'Inter','DM Sans','Segoe UI',-apple-system,Arial,sans-serif;font-size:1.55rem;font-weight:700;margin:0;color:${MARCA.texto};letter-spacing:-.02em;}
  .dash-header-chip{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid ${MARCA.borde};
                    border-radius:8px;padding:7px 14px;font-size:0.76rem;font-weight:600;color:${MARCA.verdeOscuro};
                    box-shadow:0 1px 2px rgba(16,24,32,.04);}

  .dash-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:16px;}
  @media (max-width:760px){.dash-cards{grid-template-columns:1fr;}}
  .dash-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:10px;padding:18px 20px;
             box-shadow:0 1px 2px rgba(16,24,32,.04);}
  .dash-card-lbl{font-size:0.74rem;color:${MARCA.textoSuave};font-weight:600;margin-bottom:10px;}
  .dash-card-num{font-size:1.85rem;font-weight:700;color:${MARCA.texto};line-height:1;}
  .dash-card-sub{font-size:0.76rem;color:${MARCA.textoSuave};margin-top:4px;}
  .dash-card-delta{display:inline-flex;align-items:center;gap:3px;font-size:0.74rem;font-weight:700;margin-top:10px;}
  .dash-card-delta.up{color:${MARCA.verde};}
  .dash-card-delta.down{color:${MARCA.rojo};}
  .dash-card-estrellas{color:${MARCA.oro};font-size:1rem;letter-spacing:2px;margin-top:6px;}

  .dash-charts{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
  @media (max-width:900px){.dash-charts{grid-template-columns:1fr;}}
  .dash-panel{background:#fff;border:1px solid ${MARCA.borde};border-radius:10px;padding:18px 20px;
              box-shadow:0 1px 2px rgba(16,24,32,.04);}
  .dash-panel-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:16px;}
  .dash-panel-titulo{font-size:0.9rem;font-weight:700;color:${MARCA.texto};}
  .dash-panel-sub{font-size:0.72rem;color:${MARCA.textoSuave};margin-top:2px;}
  .dash-panel-num{font-size:1.45rem;font-weight:700;color:${MARCA.texto};text-align:right;}
  .dash-panel-numlbl{font-size:0.7rem;color:${MARCA.textoSuave};text-align:right;}
  .dash-actividad-bars{display:flex;align-items:flex-end;gap:8px;height:110px;}
`;

// Página de error con la marca de Tapin — reemplaza las respuestas de texto
// plano (que se ven como una falla técnica) por algo que un cliente que paga
// por esto puede ver sin pensar "esto está a medio hacer". Se usa en los
// puntos de mayor tráfico: escaneo de tarjeta, calificar, panel de negocio,
// login de administrador.
function paginaError({ codigo = 404, titulo = "No encontramos esta página", mensaje = "Puede que el enlace esté vencido o mal escrito.", enlaceTexto = null, enlaceHref = null } = {}) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escaparHtml(titulo)} — Tapin</title>
  <style>${ESTILO_BASE}
    body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;}
    .caja-error{background:#fff;border-radius:20px;padding:44px 38px;max-width:440px;width:100%;text-align:center;
                box-shadow:0 20px 50px rgba(9,49,30,.1);border:1px solid ${MARCA.borde};box-sizing:border-box;}
    .caja-error .codigo{font-size:0.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:${MARCA.textoSuave};margin:18px 0 6px;}
    .caja-error h1{font-size:1.35rem;margin:0 0 10px;letter-spacing:-.02em;}
    .caja-error p{color:${MARCA.textoSuave};font-size:0.92rem;line-height:1.6;margin:0 0 24px;}
  </style>
</head>
<body>
  <div class="caja-error">
    ${logoSvg(MARCA.verdeOscuro, 28)}
    <div class="codigo">Error ${codigo}</div>
    <h1>${escaparHtml(titulo)}</h1>
    <p>${escaparHtml(mensaje)}</p>
    ${enlaceHref ? `<a class="btn-primario" href="${enlaceHref}">${escaparHtml(enlaceTexto || "Volver al inicio")}</a>` : ""}
  </div>
</body>
</html>`;
}
function enviarError(res, codigo, titulo, mensaje, enlace) {
  return res.status(codigo).send(paginaError({ codigo, titulo, mensaje, enlaceTexto: enlace && enlace.texto, enlaceHref: enlace && enlace.href }));
}

// Script compartido: deshabilita el botón de "guardar" apenas se envía un
// formulario y le cambia el texto, para que quede claro que la acción se
// está procesando y para que no se pueda hacer doble clic y mandar el mismo
// formulario dos veces. Se ignoran los formularios GET (búsquedas, login por
// URL) porque esos navegan de inmediato, no "guardan" nada.
const SCRIPT_ENVIO_FORMULARIO = `
document.addEventListener("submit", function (e) {
  var form = e.target;
  if (!form || (form.method && form.method.toLowerCase() === "get")) return;
  var boton = form.querySelector('button[type="submit"]');
  if (!boton || boton.disabled) return;
  boton.dataset.textoOriginal = boton.textContent;
  boton.disabled = true;
  boton.textContent = "Guardando…";
});
`;

// ---------- Configuración de negocios ----------
// Agrega aquí un negocio por cada Tapin que tengas en la calle.
// "slug" es lo que va en la URL programada en el chip NFC, ej: /r/mi-negocio
// "categoria" se usa para comparar el negocio contra otros del mismo tipo (punto 9).
// "claveAcceso" es opcional: si la pones, el dueño puede entrar a SU PROPIO panel
// (/mi-panel/slug?key=claveAcceso) sin ver los datos de tus otros negocios.
const NEGOCIOS = {
  "mi-negocio": {
    nombre: "Mi Negocio",
    googleUrl: "https://g.page/r/REEMPLAZA_CON_TU_ENLACE/review",
    categoria: "restaurante",
    pais: "colombia",
    claveAcceso: "mi-negocio-2026",
    email: "dueno@minegocio.com",
    plan: "basico", // "basico" o "pro" — solo "pro" recibe alertas, reporte mensual y contenido
    direccion: "",  // dirección legible, opcional (para mostrar en el mapa público)
    lat: null,      // latitud, opcional (para el mapa de calor de /descubre)
    lng: null,      // longitud, opcional
  },
  // "otro-local": {
  //   nombre: "Otro Local",
  //   googleUrl: "https://g.page/r/OTRO_ENLACE/review",
  //   categoria: "peluqueria",
  //   claveAcceso: "otro-local-2026",
  //   email: "dueno@otrolocal.com",
  //   plan: "pro",
  //   direccion: "Cra 7 # 12-34, Chía",
  //   lat: 4.8617,
  //   lng: -74.0397,
  // },
};

// ---------- Almacenamiento simple en archivo JSON ----------
function leerDatos() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

function guardarDatos(datos) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(datos, null, 2));
}

// ---------- Códigos de activación ----------
// Permite generar un código único por cada tarjeta Tapin física ANTES de saber
// a qué negocio va a parar. Programas el chip NFC con ese código, y cuando consigas
// el cliente, lo activas con sus datos reales (nombre, enlace de Google, categoría).

const CODIGOS_FILE = path.join(DATA_DIR, "codigos.json");

function leerCodigos() {
  if (!fs.existsSync(CODIGOS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CODIGOS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function guardarCodigos(codigos) {
  fs.writeFileSync(CODIGOS_FILE, JSON.stringify(codigos, null, 2));
}

// ---------- Varias tarjetas físicas, un mismo negocio ----------
// Un local puede tener más de una tarjeta Tapin (una por mesa, una en la
// caja, una en la entrada, etc.) sin que eso deba crear negocios distintos
// ni dividir sus estadísticas. Cuando se activa una tarjeta y se vincula a
// un negocio que YA existe (en vez de darle datos de un negocio nuevo), esa
// tarjeta se guarda con "vinculadoA: <slug del negocio principal>" y no
// tiene su propio objeto "negocio" — todo lo que pase en ella (toques,
// calificaciones, quejas, sellos de fidelización) se resuelve y se guarda
// bajo el slug del negocio principal.
//
// resolverSlug() sigue esa cadena hasta llegar al slug real que tiene los
// datos — así, cualquier parte del código que reciba un slug de la URL (que
// puede ser el de una tarjeta vinculada) puede resolverlo UNA vez y de ahí
// en adelante trabajar como si siempre hubiera sido el negocio principal.
function resolverSlug(slugOriginal, codigosCache) {
  const codigos = codigosCache || leerCodigos();
  let slug = slugOriginal;
  const visitados = new Set();
  while (codigos[slug] && codigos[slug].vinculadoA && !visitados.has(slug)) {
    visitados.add(slug);
    slug = codigos[slug].vinculadoA;
  }
  return slug;
}

// Todas las tarjetas (códigos) que hoy apuntan a un negocio principal dado —
// para mostrarlas en su panel/edición ("este negocio tiene 3 tarjetas").
function tarjetasVinculadasA(slugPrincipal, codigosCache) {
  const codigos = codigosCache || leerCodigos();
  return Object.keys(codigos).filter(
    (c) => codigos[c].vinculadoA === slugPrincipal && !codigos[c].desactivado
  );
}

// ---------- Login mágico de dueños (sin contraseña) ----------
// Un dueño puede tener varios locales (varios slugs). En vez de manejar
// usuarios y contraseñas, mandamos un link temporal por correo que, al
// abrirse, muestra todos los negocios cuyo campo "email" coincide.
const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");
function leerTokens() {
  if (!fs.existsSync(TOKENS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function guardarTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}
function generarToken() {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let t = "";
  for (let i = 0; i < 24; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

// ---------- Pagos con Wompi (checkout del Plan Básico) ----------
// Necesitas cuatro variables de entorno en Render, sacadas de tu Panel de
// Comercios de Wompi (comercios.wompi.co → Desarrolladores):
//   WOMPI_PUBLIC_KEY       → Llave pública (pub_test_.../pub_prod_...). Va
//                            en el formulario de pago (se muestra en el
//                            navegador, no es secreta) y decide si se usa
//                            el ambiente sandbox o producción.
//   WOMPI_INTEGRITY_SECRET → "Secreto de integridad". Se usa SOLO en el
//                            servidor para firmar cada venta (hash de
//                            integridad). Nunca se envía al navegador.
//   WOMPI_EVENTS_SECRET    → "Secreto de eventos" (distinto del de
//                            integridad, también sale en el panel de
//                            Wompi). Se usa para verificar que los avisos
//                            del webhook de verdad vengan de Wompi.
//   WOMPI_PRIVATE_KEY      → Llave privada (prv_test_.../prv_prod_...). Se
//                            usa SOLO en el servidor para tokenizar
//                            tarjetas (fuentes de pago reutilizables) y
//                            cobrar la mensualidad del Plan Pro sola cada
//                            mes, sin que el dueño del negocio tenga que
//                            volver a pagar a mano.
// A diferencia de Bold, Wompi trabaja los montos en CENTAVOS (amount_in_cents),
// no en pesos enteros — por eso aquí sí se multiplica por 100.
const PEDIDOS_FILE = path.join(DATA_DIR, "pedidos.json");
function leerPedidos() {
  if (!fs.existsSync(PEDIDOS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PEDIDOS_FILE, "utf8")); } catch { return {}; }
}
function guardarPedidos(pedidos) {
  fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2));
}

// Genera la firma de integridad que exige Wompi: SHA256 de
// referencia + monto_en_centavos + moneda + secreto_de_integridad (en ese
// orden, todo concatenado sin separadores). Esto se hace en el servidor
// por seguridad — si se generara en el navegador, cualquiera podría
// alterar el monto de una venta.
function firmaIntegridadWompi(referencia, montoCentavos, moneda) {
  const cadena = `${referencia}${montoCentavos}${moneda}${process.env.WOMPI_INTEGRITY_SECRET}`;
  return crypto.createHash("sha256").update(cadena).digest("hex");
}

// Wompi tiene dos ambientes con distinta URL base — se elige solo mirando
// el prefijo de la llave pública configurada (pub_prod_ = producción real,
// cualquier otra cosa = sandbox de pruebas).
function baseWompi() {
  return (process.env.WOMPI_PUBLIC_KEY || "").startsWith("pub_prod_")
    ? "https://production.wompi.co/v1"
    : "https://sandbox.wompi.co/v1";
}

// Verifica que un aviso de webhook realmente venga de Wompi (y no de
// cualquiera que le pegue a la URL). Wompi arma un checksum SHA256 con los
// valores de las propiedades listadas en payload.signature.properties (rutas
// como "transaction.id" navegadas dentro de payload.data), más el timestamp
// del evento, más el Secreto de Eventos — todo concatenado sin separadores,
// en mayúsculas al final.
function verificarChecksumWompi(payload) {
  if (!process.env.WOMPI_EVENTS_SECRET) return false;
  if (!payload || !payload.signature || !payload.signature.properties) return false;
  try {
    const valores = payload.signature.properties.map((ruta) =>
      ruta.split(".").reduce((obj, key) => (obj ? obj[key] : undefined), payload.data)
    );
    const cadena = valores.join("") + payload.timestamp + process.env.WOMPI_EVENTS_SECRET;
    const checksumCalculado = crypto.createHash("sha256").update(cadena).digest("hex").toUpperCase();
    return checksumCalculado === String(payload.signature.checksum).toUpperCase();
  } catch (err) {
    console.error("Error verificando checksum de Wompi:", err.message);
    return false;
  }
}

// ---------- Facturacion electronica (Alegra) ----------
// Cada vez que se confirma un pago (compra de tarjeta o mensualidad Pro),
// si el comprador dejo NIT/razon social, le pedimos a Alegra que genere la
// factura electronica y la envie a la DIAN -- Tapin nunca genera el XML ni
// habla directo con la DIAN, todo pasa por Alegra (proveedor tecnologico
// autorizado). Requiere dos variables de entorno en Render, sacadas de
// Alegra -> Soluciones -> Administrar mis soluciones -> Integraciones ->
// Integracion Manual (API):
//   ALEGRA_USER  -> el correo de la cuenta de Alegra.
//   ALEGRA_TOKEN -> el token de acceso a la API.
// Si estas variables no estan configuradas, o el pedido no tiene NIT, la
// factura simplemente no se genera (sin romper el resto del flujo) -- queda
// registrado en consola para revisar manualmente si hace falta.
const ALEGRA_API_BASE = "https://api.alegra.com/api/v1";
const ALEGRA_NOMBRE_ITEM_BASICO = "Plan Básico Tapin";
const ALEGRA_NOMBRE_ITEM_PRO = "Plan Pro Tapin";
// Todos los precios que maneja el resto del código (PRECIO_BASICO_COP,
// PRECIO_PRO_COP, los escalones, etc.) son precios CON IVA incluido -- es lo
// que Wompi le cobra de verdad al cliente. Pero el campo "price" que la API
// de Alegra espera en cada línea de factura es el precio ANTES de IVA (el
// mismo dato que en el formulario de Alegra se llama "Precio base"): Alegra
// le suma el IVA que tenga configurado el ítem para calcular el total. Por
// eso, antes de mandarle el precio a Alegra, hay que "quitarle" el IVA --
// si no, la factura queda cobrando IVA sobre un monto que ya lo incluía.
const IVA_TAPIN = 0.19;
function precioSinIva(montoConIva) {
  return Math.round(montoConIva / (1 + IVA_TAPIN));
}

function alegraConfigurado() {
  return !!(process.env.ALEGRA_USER && process.env.ALEGRA_TOKEN);
}

function alegraAuthHeader() {
  const credenciales = Buffer.from(`${process.env.ALEGRA_USER}:${process.env.ALEGRA_TOKEN}`).toString("base64");
  return `Basic ${credenciales}`;
}

// Envoltorio delgado sobre fetch para hablar con la API de Alegra: agrega
// la autenticacion y decodifica la respuesta. Lanza un error legible si
// Alegra responde con algo distinto a 2xx (por ejemplo, plan sin acceso a
// la API), para que quede claro en los logs de Render que fallo.
async function alegraPeticion(ruta, opciones = {}) {
  const resp = await fetch(`${ALEGRA_API_BASE}${ruta}`, {
    ...opciones,
    headers: {
      Authorization: alegraAuthHeader(),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(opciones.headers || {}),
    },
  });
  const texto = await resp.text();
  let cuerpo = null;
  try { cuerpo = texto ? JSON.parse(texto) : null; } catch { cuerpo = texto; }
  if (!resp.ok) {
    const detalle = (cuerpo && (cuerpo.message || JSON.stringify(cuerpo))) || resp.statusText;
    throw new Error(`Alegra respondio ${resp.status}: ${detalle}`);
  }
  return cuerpo;
}

// Busca un contacto (cliente) en Alegra por numero de identificacion (NIT o
// cedula). Si no existe, lo crea. Devuelve el id numerico que pide Alegra
// para armar la factura.
async function buscarOCrearContactoAlegra({ nit, razonSocial, email }) {
  const identificacion = (nit || "").replace(/[^0-9]/g, "");
  if (!identificacion) throw new Error("Falta el NIT para crear el contacto en Alegra.");

  const encontrados = await alegraPeticion(`/contacts?identification=${encodeURIComponent(identificacion)}`);
  if (Array.isArray(encontrados) && encontrados.length > 0) {
    return encontrados[0].id;
  }

  const nuevo = await alegraPeticion("/contacts", {
    method: "POST",
    body: JSON.stringify({
      name: razonSocial || "Cliente Tapin",
      identification: identificacion,
      email: email || undefined,
      type: ["client"],
    }),
  });
  return nuevo.id;
}

// Busca en el catalogo de Alegra el item (producto/servicio) con este
// nombre exacto -- "Plan Basico Tapin" o "Plan Pro Tapin". Hay que crearlos
// una sola vez a mano en Alegra (Inventario -> Items) antes de que esto
// funcione; aqui solo se busca su id para poder referenciarlo en la factura.
const cacheItemsAlegra = {};
async function buscarItemAlegraPorNombre(nombre) {
  if (cacheItemsAlegra[nombre]) return cacheItemsAlegra[nombre];
  const encontrados = await alegraPeticion(`/items?query=${encodeURIComponent(nombre)}&limit=5`);
  const coincidencia = Array.isArray(encontrados)
    ? encontrados.find((it) => (it.name || "").trim().toLowerCase() === nombre.trim().toLowerCase())
    : null;
  if (!coincidencia) {
    throw new Error(`No se encontro el item "${nombre}" en el catalogo de Alegra. Crealo en Inventario -> Items con ese nombre exacto.`);
  }
  cacheItemsAlegra[nombre] = coincidencia.id;
  return coincidencia.id;
}

// Crea (y valida ante la DIAN) la factura electronica de una venta de
// Tapin. "items" es un array de { nombreItem, cantidad, precioUnitario }.
// No lanza hacia arriba si algo falla -- un problema de facturacion no debe
// tumbar la activacion de una tarjeta ni el registro de un pago; solo se
// deja constancia clara en los logs para revisarlo a mano.
// Si la venta no trae NIT, NO se omite la factura: como responsable de IVA
// hay que facturar TODAS las ventas, asi que se emite a nombre del
// "consumidor final" con el NIT generico 222222222222 que la normatividad
// DIAN define exactamente para este caso.
const NIT_CONSUMIDOR_FINAL = "222222222222";
async function crearFacturaAlegra({ nit, razonSocial, email, items, referencia }) {
  if (!alegraConfigurado()) {
    console.warn(`[Alegra] ALEGRA_USER/ALEGRA_TOKEN no configurados -- no se genero factura para ${referencia}.`);
    return null;
  }
  const nitLimpio = (nit || "").trim();
  const nitFactura = nitLimpio || NIT_CONSUMIDOR_FINAL;
  const razonFactura = nitLimpio ? razonSocial : "Consumidor final";
  try {
    const clienteId = await buscarOCrearContactoAlegra({ nit: nitFactura, razonSocial: razonFactura, email: nitLimpio ? email : undefined });
    const itemsAlegra = [];
    for (const it of items) {
      const itemId = await buscarItemAlegraPorNombre(it.nombreItem);
      itemsAlegra.push({ id: itemId, price: precioSinIva(it.precioUnitario), quantity: it.cantidad || 1 });
    }
    const factura = await alegraPeticion("/invoices", {
      method: "POST",
      body: JSON.stringify({
        status: "open",
        date: new Date().toISOString().slice(0, 10),
        dueDate: new Date().toISOString().slice(0, 10),
        client: clienteId,
        items: itemsAlegra,
        anotation: `Tapin -- referencia ${referencia}`,
        // Pide a Alegra emitir la factura electronicamente ante la DIAN de
        // una vez (sin esto puede quedar como borrador interno sin validar).
        // Si las facturas aparecen en Alegra pero sin numero DIAN, revisar
        // este campo contra la documentacion vigente de su API.
        stamp: { generateStamp: true },
      }),
    });
    console.log(`[Alegra] Factura ${factura?.numberTemplate?.fullNumber || factura?.id || ""} creada para ${referencia}.`);
    return factura;
  } catch (err) {
    console.error(`[Alegra] Error creando factura para ${referencia}:`, err.message);
    return null;
  }
}

// ---------- Cuentas de cliente (persona normal) ----------
// A diferencia del dueño de negocio (que entra sin contraseña, por link mágico),
// el cliente sí crea una cuenta real con correo + contraseña, porque necesitamos
// identificarlo de forma persistente para guardar sus favoritos y su historial
// de reseñas entre visitas.
const crypto = require("crypto");
const CLIENTES_FILE = path.join(DATA_DIR, "clientes.json");
const SESIONES_FILE = path.join(DATA_DIR, "sesiones-clientes.json");

function leerClientes() {
  if (!fs.existsSync(CLIENTES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CLIENTES_FILE, "utf8")); } catch { return {}; }
}
function guardarClientes(clientes) {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify(clientes, null, 2));
}
function leerSesionesClientes() {
  if (!fs.existsSync(SESIONES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SESIONES_FILE, "utf8")); } catch { return {}; }
}
function guardarSesionesClientes(sesiones) {
  fs.writeFileSync(SESIONES_FILE, JSON.stringify(sesiones, null, 2));
}

// Hashea la contraseña con scrypt (nativo de Node, no necesita librerías externas
// como bcrypt). Cada cuenta tiene su propia "sal" aleatoria.
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function crearHashConSal(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}
function verificarPassword(password, salt, hashGuardado) {
  const hashIntento = hashPassword(password, salt);
  // Comparación en tiempo constante para no filtrar info por timing.
  const a = Buffer.from(hashIntento, "hex");
  const b = Buffer.from(hashGuardado, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Clave de acceso de negocio: cifrada con scrypt (igual que las
// contraseñas de clientes), en vez de guardada en texto plano en codigos.json.
// Como ya había negocios activos con la clave en texto plano ANTES de este
// cambio, tieneClaveConfigurada() y claveNegocioValida() saben leer ambos
// formatos — y en cuanto un negocio viejo entra una vez con su clave de
// siempre, se migra sola a cifrada en ese mismo momento, sin que el dueño
// tenga que hacer nada ni se quede sin poder entrar.
function tieneClaveConfigurada(negocio) {
  return !!(negocio && (negocio.claveAcceso || negocio.claveAccesoHash));
}
function claveNegocioValida(negocio, slug, intento) {
  if (!intento || !negocio) return false;
  // Un link de acceso temporal (generado por el propio servidor para correos
  // o navegación entre sedes) — no es la clave real, es un token aparte.
  if (typeof intento === "string" && intento.startsWith("tok_")) {
    const tokens = leerTokensAccesoNegocio();
    const entrada = tokens[intento];
    return !!(entrada && entrada.slug === slug && new Date(entrada.expiraEl) > new Date());
  }
  if (negocio.claveAccesoHash && negocio.claveAccesoSalt) {
    return verificarPassword(intento, negocio.claveAccesoSalt, negocio.claveAccesoHash);
  }
  // Cuenta vieja, todavía con la clave en texto plano.
  if (negocio.claveAcceso && intento === negocio.claveAcceso) {
    if (slug) {
      const { salt, hash } = crearHashConSal(intento);
      guardarCambiosNegocio(slug, negocio, { claveAccesoHash: hash, claveAccesoSalt: salt, claveAcceso: undefined });
    }
    return true;
  }
  return false;
}
// Genera la pareja {hash, salt} para guardar una clave de negocio nueva —
// se usa al activar una tarjeta, al crear un negocio a mano, o al cambiar
// la clave desde el panel. Nunca se guarda el texto plano después de esto.
function hashClaveNegocio(claveTextoPlano) {
  return crearHashConSal(claveTextoPlano);
}

// Algunos links los arma el SERVIDOR solo, sin que el negocio haya escrito su
// clave en esa petición (ej: un correo automático de recordatorio, o el link
// para saltar a "tu otra sede" desde el panel) — antes esos links usaban
// negocio.claveAcceso directamente. Ahora que la clave está cifrada, el
// servidor ya no la puede leer de vuelta, así que estos links usan en su
// lugar un token temporal de un solo propósito, independiente de la clave real.
const TOKENS_ACCESO_NEGOCIO_FILE = path.join(DATA_DIR, "tokens-acceso-negocio.json");
function leerTokensAccesoNegocio() {
  if (!fs.existsSync(TOKENS_ACCESO_NEGOCIO_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(TOKENS_ACCESO_NEGOCIO_FILE, "utf8")); } catch { return {}; }
}
function guardarTokensAccesoNegocio(tokens) {
  fs.writeFileSync(TOKENS_ACCESO_NEGOCIO_FILE, JSON.stringify(tokens, null, 2));
}
function generarLinkAccesoNegocio(slug, diasValidez = 7, esAdmin = false) {
  const tokens = leerTokensAccesoNegocio();
  // limpieza de tokens vencidos, para que el archivo no crezca sin control
  const ahora = Date.now();
  for (const t in tokens) {
    if (new Date(tokens[t].expiraEl).getTime() < ahora) delete tokens[t];
  }
  const token = "tok_" + generarToken();
  // Los tokens generados para el administrador (al entrar desde /stats) llevan
  // esAdmin:true — así el panel no le exige plan Pro al negocio para dejarlo
  // ver secciones Pro mientras navega en modo administrador.
  tokens[token] = { slug, expiraEl: new Date(ahora + diasValidez * 24 * 60 * 60 * 1000).toISOString(), esAdmin };
  guardarTokensAccesoNegocio(tokens);
  return token;
}
// Indica si una clave/intento es un token temporal emitido específicamente
// para el administrador (y no uno normal de dueño de negocio).
function claveEsTokenAdmin(intento) {
  if (typeof intento !== "string" || !intento.startsWith("tok_")) return false;
  const tokens = leerTokensAccesoNegocio();
  const entrada = tokens[intento];
  return !!(entrada && entrada.esAdmin && new Date(entrada.expiraEl) > new Date());
}

// Lee cookies manualmente del header (sin depender de cookie-parser).
function leerCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((parte) => {
    const [k, ...v] = parte.trim().split("=");
    if (k) cookies[k] = decodeURIComponent(v.join("=") || "");
  });
  return cookies;
}

// Sesión corta del administrador. Permite que, después de validar ADMIN_KEY
// en /stats o /admin/entrar, el administrador abra cualquier panel de negocio
// sin volver a escribir la clave del negocio. La cookie no contiene ADMIN_KEY.
const ADMIN_SESSION_COOKIE = "tapin_admin_sesion";
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || ADMIN_KEY;
function firmaSesionAdmin(valor) {
  return crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(valor).digest("hex");
}
function iniciarSesionAdmin(res) {
  const payload = `${Date.now()}.${generarToken()}`;
  const valor = `${payload}.${firmaSesionAdmin(payload)}`;
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(valor)}; Max-Age=${ADMIN_SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
}
function adminSesionValida(req) {
  const valor = leerCookies(req)[ADMIN_SESSION_COOKIE];
  if (!valor) return false;
  const partes = valor.split(".");
  if (partes.length !== 3) return false;
  const [momento, aleatorio, firma] = partes;
  const edad = Date.now() - Number(momento);
  if (!aleatorio || !Number.isFinite(edad) || edad < 0 || edad > ADMIN_SESSION_TTL_SECONDS * 1000) return false;
  const esperada = firmaSesionAdmin(`${momento}.${aleatorio}`);
  const a = Buffer.from(firma || "", "hex");
  const b = Buffer.from(esperada, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Dado un request, devuelve el cliente logueado (o null) a partir de la cookie de sesión.
function clienteActual(req) {
  const cookies = leerCookies(req);
  const token = cookies.tapin_sesion;
  if (!token) return null;
  const sesiones = leerSesionesClientes();
  const clienteId = sesiones[token];
  if (!clienteId) return null;
  const clientes = leerClientes();
  return clientes[clienteId] ? { id: clienteId, ...clientes[clienteId] } : null;
}

function iniciarSesionCliente(res, clienteId, recordar = true) {
  const sesiones = leerSesionesClientes();
  const token = generarToken() + generarToken(); // más largo que los magic links, es persistente
  sesiones[token] = clienteId;
  guardarSesionesClientes(sesiones);
  // Si "recordar" está marcado, la sesión dura 30 días. Si no, es una cookie
  // de sesión normal — se borra sola al cerrar el navegador.
  const maxAge = recordar ? `Max-Age=${30 * 24 * 60 * 60}; ` : "";
  res.setHeader("Set-Cookie", `tapin_sesion=${token}; HttpOnly; Secure; Path=/; ${maxAge}SameSite=Lax`);
}

function generarCodigo() {
  // Código corto, fácil de escribir a mano si toca, ej: "7K9P2M"
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O/1/I para evitar confusión
  let codigo = "";
  for (let i = 0; i < 6; i++) {
    codigo += chars[Math.floor(Math.random() * chars.length)];
  }
  return codigo;
}

// Busca un negocio primero en NEGOCIOS (configurado a mano en el código)
// y si no lo encuentra, en los códigos de activación ya activados.
// Esto permite que /r/:slug funcione igual para ambos casos.
function obtenerNegocio(slugOriginal) {
  const codigos = leerCodigos();
  // Si "slugOriginal" es una tarjeta vinculada a otro negocio (varias
  // tarjetas físicas de un mismo local), esto la resuelve al negocio
  // principal — así da igual con cuál de las tarjetas del local se entre,
  // siempre se ve la misma información.
  const slug = resolverSlug(slugOriginal, codigos);
  const entrada = codigos[slug];
  if (entrada && entrada.desactivado) return null; // tarjeta quitada explícitamente
  if (entrada && entrada.activado && entrada.negocio) {
    return {
      ...entrada.negocio,
      claveAcceso: entrada.negocio.claveAcceso || entrada.claveAcceso || `${slug.toLowerCase()}-panel`,
    };
  }
  if (NEGOCIOS[slug]) return NEGOCIOS[slug];
  return null;
}

// Funciones exclusivas de Plan Pro: retroalimentación privada + alerta instantánea
// ante retroalimentación negativa, registro detallado toque por toque, reporte
// mensual (correo + PDF con picos/caídas por hora), exportación de reportes
// (CSV/PDF/Word), y comparación sectorial.
// El plan básico (pago único) solo incluye: tarjeta física + envío, redirección
// automática a Google, panel con historial y estadísticas resumidas, y acta de entrega.
// Si el negocio no tiene plan "pro", estas simplemente no se disparan — sin
// importar si el código las soporta técnicamente.
function esPro(negocio) {
  if (!negocio || negocio.plan !== "pro") return false;
  // Si pagó el plan anual, sigue siendo Pro solo hasta que se cumpla el año —
  // después de esa fecha, deja de contar como Pro hasta que renueve.
  if (negocio.billingType === "anual" && negocio.proAnualHasta) {
    return new Date(negocio.proAnualHasta) > new Date();
  }
  // Si canceló su suscripción mensual, sigue siendo Pro hasta el final del
  // período que ya pagó (vigenteHasta) — después de esa fecha, baja solo a
  // Básico, sin que nadie tenga que hacerlo a mano.
  if (negocio.suscripcion && negocio.suscripcion.vigenteHasta) {
    return new Date(negocio.suscripcion.vigenteHasta) > new Date();
  }
  return true;
}

// Escapa HTML para que texto escrito por clientes (comentarios de quejas,
// nombres, etc.) nunca se interprete como código — sin esto, alguien podría
// escribir <script> en un comentario y que se ejecute cuando el negocio abra
// su panel o su correo de alerta. Se usa en TODO texto libre de usuario que
// se inserta en HTML.
function escaparHtml(texto) {
  return String(texto == null ? "" : texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Valida que un link realmente sea del formulario de RESEÑAS de Google (no
// de Google Maps a secas), para no dejar pasar por error un link que rompería
// la redirección de "toca la tarjeta → deja una reseña en 1 clic". El link de
// "Compartir" de Google Maps (maps.app.goo.gl, o www.google.com/maps/place/...)
// solo muestra el negocio en el mapa — no abre el formulario de reseña — así
// que se rechaza explícitamente aunque el dominio sea de Google.
function esLinkGoogleValido(url) {
  const dominiosValidos = ["google.com", "g.page", "goo.gl"];
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^www\./, "");
  const esDominioGoogle = dominiosValidos.some((d) => host === d || host.endsWith("." + d));
  if (!esDominioGoogle) return false;
  if (host === "maps.app.goo.gl") return false; // link de "Compartir" de Maps, no de reseñas
  if (/\/maps\/(place|@)/.test(u.pathname)) return false; // link de ubicación en Maps, no de reseñas
  return true;
}

// Lee una cookie sin depender de ningún paquete adicional (parseo manual del
// header Cookie), y arma el valor a guardar cuando alguien se autentica con
// éxito — así la clave no tiene que viajar en cada link del panel.
function leerCookie(req, nombre) {
  const cabecera = req.headers.cookie;
  if (!cabecera) return null;
  const partes = cabecera.split(";").map((c) => c.trim());
  for (const parte of partes) {
    const [k, ...v] = parte.split("=");
    if (k === nombre) return decodeURIComponent(v.join("="));
  }
  return null;
}
function ponerCookieSesion(res, slug, clave) {
  const valor = encodeURIComponent(clave);
  res.setHeader(
    "Set-Cookie",
    `tapin_sesion_${slug}=${valor}; Max-Age=${60 * 60 * 24 * 30}; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
}
// Da la clave efectiva a usar: la de la URL si vino, si no la de la cookie de
// esa sesión — así una vez que entraste una vez con el link completo, las
// visitas siguientes no necesitan la clave visible en la URL.
function claveEfectiva(req, slug) {
  return req.query.key || leerCookie(req, `tapin_sesion_${slug}`) || null;
}

// Autoriza al admin (ADMIN_KEY) O al dueño del negocio con su propia clave,
// siempre que el negocio sea Pro — usado en las funciones que antes eran
// "solo admin" (quejas, exportes) para que el negocio también
// pueda entrar directamente con su clave de panel.
function autorizadoProNegocio(req, negocio, slug) {
  const key = slug ? claveEfectiva(req, slug) : req.query.key;
  if (key === ADMIN_KEY) return true;
  if (!tieneClaveConfigurada(negocio)) return false;
  if (!claveNegocioValida(negocio, slug, key)) return false;
  // Si el administrador está navegando el panel (token emitido para él),
  // puede ver las secciones Pro aunque el negocio esté en plan Básico.
  if (claveEsTokenAdmin(key)) return true;
  return esPro(negocio);
}

// Detecta tipo de dispositivo de forma simple a partir del user-agent
function detectarDispositivo(userAgent = "") {
  const ua = userAgent.toLowerCase();
  if (ua.includes("iphone") || ua.includes("ipad")) return "iPhone/iPad";
  if (ua.includes("android")) return "Android";
  if (ua.includes("windows")) return "Windows";
  if (ua.includes("mac")) return "Mac";
  return "Desconocido";
}

// Calcula métricas de resumen para el dashboard: hoy, esta semana, último toque,
// y un mini-histograma de los últimos 7 días (para la barra tipo gráfica).
// Convierte una fecha ISO en un texto relativo tipo "Hace 2 horas" — usado
// en la lista de actividad reciente del panel para que se lea como un
// dashboard de verdad, no como una tabla de auditoría.
function tiempoRelativo(fechaISO) {
  const diffMs = Math.max(0, Date.now() - new Date(fechaISO).getTime());
  const minutos = Math.floor(diffMs / 60000);
  if (minutos < 1) return "Hace un momento";
  if (minutos < 60) return `Hace ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `Hace ${horas} hora${horas === 1 ? "" : "s"}`;
  const dias = Math.floor(horas / 24);
  if (dias < 30) return `Hace ${dias} día${dias === 1 ? "" : "s"}`;
  const meses = Math.floor(dias / 30);
  return `Hace ${meses} mes${meses === 1 ? "" : "es"}`;
}

function calcularResumen(eventos) {
  const ahora = new Date();
  const inicioHoy = new Date(ahora);
  inicioHoy.setHours(0, 0, 0, 0);

  let hoy = 0;
  let semana = 0;
  const dias7 = new Array(7).fill(0); // [hace 6 dias, ..., hoy]
  const inicioSemana = new Date(inicioHoy);
  inicioSemana.setDate(inicioSemana.getDate() - 6);

  for (const e of eventos) {
    const fecha = new Date(e.fechaISO);
    if (fecha >= inicioHoy) hoy++;
    if (fecha >= inicioSemana) semana++;

    const diffDias = Math.floor((inicioHoy - new Date(fecha).setHours(0, 0, 0, 0)) / 86400000);
    if (diffDias >= 0 && diffDias < 7) {
      dias7[6 - diffDias]++;
    }
  }

  const ultimo = eventos.length ? eventos[eventos.length - 1] : null;

  return { hoy, semana, dias7, ultimo, total: eventos.length };
}

// Compara actividad entre las tarjetas físicas de un mismo negocio (la
// principal + las que estén vinculadas) — para que el dueño vea cuál
// funciona mejor (más toques) y no solo el total combinado.
function resumenPorTarjeta(slugPrincipal, eventos, codigosCache) {
  const codigos = codigosCache || leerCodigos();
  const vinculadas = tarjetasVinculadasA(slugPrincipal, codigos);
  const tarjetas = [slugPrincipal, ...vinculadas];
  return tarjetas
    .map((codigo) => {
      // Los eventos de ANTES de que existiera esto no tienen codigoTarjeta —
      // se cuentan para la principal, porque en ese momento no podían venir
      // de ninguna otra (las tarjetas vinculadas no existían todavía).
      const eventosTarjeta = eventos.filter((e) =>
        codigo === slugPrincipal ? (!e.codigoTarjeta || e.codigoTarjeta === codigo) : e.codigoTarjeta === codigo
      );
      const resumen = calcularResumen(eventosTarjeta);
      return {
        codigo,
        etiqueta: (codigos[codigo] && codigos[codigo].etiqueta) || null,
        esPrincipal: codigo === slugPrincipal,
        hoy: resumen.hoy,
        semana: resumen.semana,
        total: resumen.total,
      };
    })
    .sort((a, b) => b.total - a.total);
}

// Analiza la actividad por hora del día (0-23) durante el último mes, para
// identificar picos (horas de más movimiento) y caídas (horas muertas).
// También compara la última semana contra la anterior para ver si el pico
// de actividad está subiendo o bajando.
function analizarHoras(eventos, negocio) {
  const ahora = new Date();
  const hace30Dias = new Date(ahora);
  hace30Dias.setDate(hace30Dias.getDate() - 30);

  const porHora = new Array(24).fill(0);
  let totalMes = 0;

  for (const e of eventos) {
    const fecha = new Date(e.fechaISO);
    if (fecha < hace30Dias) continue;
    totalMes++;
    // Usamos la hora local del negocio, no la del servidor, para que el
    // pico/caída refleje la realidad del negocio (ej: hora de almuerzo real).
    const horaLocalStr = fecha.toLocaleString("en-US", { timeZone: zonaDe(negocio), hour: "2-digit", hour12: false });
    const hora = parseInt(horaLocalStr, 10) % 24;
    porHora[hora]++;
  }

  const maxToques = Math.max(...porHora);
  const horasConDatos = porHora.filter((v) => v > 0).length;
  const picoHora = porHora.indexOf(maxToques);

  // "Caída" = la hora con menos actividad, mirando solo horas dentro del
  // rango donde el negocio SÍ ha tenido algún toque alguna vez (para no
  // marcar como "caída" la 3am si el negocio nunca abre a esa hora).
  let horaCaida = null;
  let minToques = Infinity;
  const horasActivas = porHora
    .map((v, h) => ({ h, v }))
    .filter(({ h }) => porHora[h] > 0 || (h >= 6 && h <= 22)); // rango razonable de horario comercial
  horasActivas.forEach(({ h, v }) => {
    if (v < minToques) { minToques = v; horaCaida = h; }
  });

  // Comparativo semana actual vs semana anterior, en la hora pico detectada.
  const inicioSemanaActual = new Date(ahora);
  inicioSemanaActual.setDate(inicioSemanaActual.getDate() - 7);
  const inicioSemanaAnterior = new Date(ahora);
  inicioSemanaAnterior.setDate(inicioSemanaAnterior.getDate() - 14);

  let picoSemanaActual = 0;
  let picoSemanaAnterior = 0;
  for (const e of eventos) {
    const fecha = new Date(e.fechaISO);
    const horaLocalStr = fecha.toLocaleString("en-US", { timeZone: zonaDe(negocio), hour: "2-digit", hour12: false });
    const hora = parseInt(horaLocalStr, 10) % 24;
    if (hora !== picoHora) continue;
    if (fecha >= inicioSemanaActual) picoSemanaActual++;
    else if (fecha >= inicioSemanaAnterior) picoSemanaAnterior++;
  }

  return {
    porHora, totalMes, maxToques, picoHora, horaCaida, minToques: minToques === Infinity ? 0 : minToques,
    horasConDatos, picoSemanaActual, picoSemanaAnterior,
    tendenciaPico: picoSemanaActual - picoSemanaAnterior,
  };
}

// Idea 5: mirando TODO el histórico (no solo la última semana), ¿cuál día de
// la semana rinde menos? Necesita al menos 3 días distintos con datos para
// que la conclusión tenga algo de sentido — si no, devuelve null.
function diaMasFlojo(eventos, negocio) {
  const zona = zonaDe(negocio);
  const porDia = new Array(7).fill(0); // 0=domingo ... 6=sábado
  const mapaDia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  for (const e of eventos) {
    const nombreCorto = new Date(e.fechaISO).toLocaleString("en-US", { timeZone: zona, weekday: "short" });
    porDia[mapaDia[nombreCorto]]++;
  }
  const conDatos = porDia.map((v, i) => ({ v, i })).filter((d) => d.v > 0);
  if (conDatos.length < 3) return null;
  const min = conDatos.reduce((a, b) => (b.v < a.v ? b : a));
  const nombres = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  return { dia: nombres[min.i], toques: min.v };
}

// Idea 6: compara esta semana contra el PROPIO promedio histórico del
// negocio (no contra el sector) — si cayó fuerte, avisa. Necesita algo de
// histórico acumulado para que el promedio signifique algo.
function alertaCaidaPropia(eventos, semanaActual) {
  if (eventos.length < 10) return null;
  const primerEvento = new Date(eventos[0].fechaISO);
  const semanasTranscurridas = Math.max(1, Math.round((Date.now() - primerEvento.getTime()) / (7 * 86400000)));
  const promedioSemanal = eventos.length / semanasTranscurridas;
  if (promedioSemanal < 3) return null; // muy poco volumen para que el aviso sirva de algo
  if (semanaActual < promedioSemanal * 0.6) {
    return {
      pctCaida: Math.round((1 - semanaActual / promedioSemanal) * 100),
      promedioSemanal: Math.round(promedioSemanal),
    };
  }
  return null;
}

// Idea 7: cuántos clientes CON CUENTA en Tapin han calificado este negocio 3
// veces o más — es la mejor señal de clientes recurrentes que ya tenemos,
// sin pedir ningún dato nuevo.
function contarClientesRecurrentes(slug) {
  const clientes = leerClientes();
  let recurrentes = 0;
  for (const id in clientes) {
    const visitas = (clientes[id].historial || []).filter((h) => h.slug === slug).length;
    if (visitas >= 3) recurrentes++;
  }
  return recurrentes;
}

// Idea 8: percentil del negocio dentro de su propia categoría y país, según
// toques de la última semana — sin exponer nombres de la competencia.
// Necesita al menos 3 negocios de la misma categoría para que un percentil
// tenga sentido.
function percentilCategoria(negocio, slug, todosNegocios, datos) {
  const pares = Object.entries(todosNegocios).filter(
    ([s, n]) => n.categoria === negocio.categoria && n.pais === negocio.pais
  );
  if (pares.length < 3) return null;
  const valores = pares.map(([s]) => calcularResumen((datos[s] && datos[s].eventos) || []).semana);
  const propio = calcularResumen((datos[slug] && datos[slug].eventos) || []).semana;
  const debajoOigual = valores.filter((v) => v <= propio).length;
  return Math.round((debajoOigual / valores.length) * 100);
}

// Idea 1/11: compara el mes calendario actual contra el mes calendario
// anterior (no "últimos 30 días" — mes de verdad, del 1 al 1).
function compararMesAnterior(eventos, negocio) {
  const zona = zonaDe(negocio);
  const ahora = new Date();
  const inicioMesActual = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
  const inicioMesAnterior = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);

  let mesActual = 0, mesAnterior = 0;
  for (const e of eventos) {
    const fecha = new Date(e.fechaISO);
    if (fecha >= inicioMesActual) mesActual++;
    else if (fecha >= inicioMesAnterior && fecha < inicioMesActual) mesAnterior++;
  }
  if (mesAnterior === 0) return { mesActual, mesAnterior, disponible: mesAnterior > 0 };
  const cambioPct = Math.round(((mesActual - mesAnterior) / mesAnterior) * 100);
  return { mesActual, mesAnterior, cambioPct, disponible: true };
}

// Idea 21: mismo mes calendario, pero contra el año pasado — solo funciona
// cuando ya hay un año de historia, así que casi siempre da null por ahora.
function compararAnioAnterior(eventos, negocio) {
  const ahora = new Date();
  const inicioMesActual = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
  const inicioMesAnioPasado = new Date(ahora.getFullYear() - 1, ahora.getMonth(), 1);
  const finMesAnioPasado = new Date(ahora.getFullYear() - 1, ahora.getMonth() + 1, 1);

  let mesActual = 0, mesAnioPasado = 0;
  for (const e of eventos) {
    const fecha = new Date(e.fechaISO);
    if (fecha >= inicioMesActual) mesActual++;
    else if (fecha >= inicioMesAnioPasado && fecha < finMesAnioPasado) mesAnioPasado++;
  }
  if (mesAnioPasado === 0) return null; // no hay suficiente historia todavía
  const cambioPct = Math.round(((mesActual - mesAnioPasado) / mesAnioPasado) * 100);
  return { mesActual, mesAnioPasado, cambioPct };
}

// Idea 4: calendario tipo mapa de calor del mes actual — cuadrito por día,
// más oscuro entre más toques tuvo ese día.
function calendarioMes(eventos, negocio) {
  const zona = zonaDe(negocio);
  const ahora = new Date();
  const anio = ahora.getFullYear(), mes = ahora.getMonth();
  const diasEnMes = new Date(anio, mes + 1, 0).getDate();
  const conteo = new Array(diasEnMes + 1).fill(0);
  for (const e of eventos) {
    const fecha = new Date(e.fechaISO);
    if (fecha.getFullYear() === anio && fecha.getMonth() === mes) {
      conteo[fecha.getDate()]++;
    }
  }
  const max = Math.max(1, ...conteo);
  return { dias: conteo.slice(1), max, primerDiaSemana: new Date(anio, mes, 1).getDay() };
}

// Idea 20: progreso hacia la meta mensual que el negocio se puso.
function progresoMeta(eventos, metaMensual) {
  if (!metaMensual || metaMensual <= 0) return null;
  const ahora = new Date();
  const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
  const toquesMes = eventos.filter((e) => new Date(e.fechaISO) >= inicioMes).length;
  return { toquesMes, metaMensual, pct: Math.min(100, Math.round((toquesMes / metaMensual) * 100)) };
}

// Fraccion del dia de hoy ya transcurrida (0 a 1), en la zona horaria del
// negocio -- ej: si son las 6pm (18:00), devuelve 0.75. Se usa para que la
// proyeccion no trate "hoy" como un dia completo cuando apenas va a mitad,
// que era el bug: antes, a las 9am con 2 toques, la proyeccion del dia
// mostraba "2" en vez de estimar cuantos toques van a caer para el cierre.
function fraccionDiaTranscurrida(negocio) {
  const partes = new Date().toLocaleString("en-US", {
    timeZone: zonaDe(negocio), hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const [horaStr, minutoStr] = partes.split(":");
  const hora = parseInt(horaStr, 10) % 24; // "24:00" a medianoche -> 0
  const minuto = parseInt(minutoStr, 10) || 0;
  return (hora + minuto / 60) / 24;
}

// Proyeccion simple y transparente de cierre de periodo basada en el ritmo
// real de actividad. El tiempo transcurrido se cuenta en dias completos
// mas la fraccion de hoy que ya paso (no como si "hoy" ya hubiera
// terminado) -- asi el ritmo diario promedio, y por lo tanto la
// proyeccion, es preciso sin importar a que hora del dia se consulte.
function proyeccionPeriodo(eventos, negocio, periodo) {
  const ahora = new Date();
  const inicioSemana = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  inicioSemana.setHours(0, 0, 0, 0);
  const diaSemana = inicioSemana.getDay() || 7;
  inicioSemana.setDate(inicioSemana.getDate() - diaSemana + 1);
  const finSemana = new Date(inicioSemana);
  finSemana.setDate(finSemana.getDate() + 7);
  const configuraciones = {
    dia: { etiqueta: "1 día", inicio: new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()), fin: new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + 1) },
    semana: { etiqueta: "1 semana", inicio: inicioSemana, fin: finSemana },
    mes: { etiqueta: "1 mes", inicio: new Date(ahora.getFullYear(), ahora.getMonth(), 1), fin: new Date(ahora.getFullYear(), ahora.getMonth() + 1, 1) },
    semestre: { etiqueta: "6 meses", inicio: new Date(ahora.getFullYear(), ahora.getMonth() < 6 ? 0 : 6, 1), fin: new Date(ahora.getFullYear(), ahora.getMonth() < 6 ? 6 : 12, 1) },
    anio: { etiqueta: "1 año", inicio: new Date(ahora.getFullYear(), 0, 1), fin: new Date(ahora.getFullYear() + 1, 0, 1) },
  };
  const config = configuraciones[periodo] || configuraciones.mes;
  const totalDias = Math.max(1, Math.round((config.fin - config.inicio) / 86400000));
  // Dias completos ya pasados (sin contar hoy) + la fraccion de hoy que ya
  // transcurrio. Piso de 1 hora (1/24) para no dividir por un numero casi
  // cero justo despues de medianoche, lo que dispararia el promedio.
  const diasCompletosAntes = Math.max(0, Math.floor((ahora - config.inicio) / 86400000));
  const transcurridos = Math.min(totalDias, Math.max(1 / 24, diasCompletosAntes + fraccionDiaTranscurrida(negocio)));
  const restantes = Math.max(0, Math.ceil((config.fin - ahora) / 86400000));
  const toquesPeriodo = eventos.filter((e) => {
    const fecha = new Date(e.fechaISO);
    return fecha >= config.inicio && fecha <= ahora;
  }).length;
  const suficiente = periodo === "dia" ? toquesPeriodo >= 1 : toquesPeriodo >= 3;
  const promedio = toquesPeriodo / transcurridos;
  const proyectado = Math.max(toquesPeriodo, Math.round(promedio * totalDias));
  return {
    suficiente,
    periodo,
    etiqueta: config.etiqueta,
    nombrePeriodo: periodo === "anio" ? `${config.etiqueta} ${ahora.getFullYear()}` : config.etiqueta,
    nombreMes: ahora.toLocaleDateString("es-CO", { month: "long", year: "numeric", timeZone: zonaDe(negocio) }),
    toquesMes: toquesPeriodo,
    proyectado,
    promedio: Math.round(promedio * 100) / 100,
    minimo: suficiente ? Math.max(toquesPeriodo, Math.round(proyectado * 0.85)) : 0,
    maximo: suficiente ? Math.round(proyectado * 1.15) : 0,
    restantes,
  };
}

// La proyeccion de cierre de mes (usada en el informe PDF) es solo el caso
// "mes" de proyeccionPeriodo -- una sola implementacion, sin logica
// duplicada que se pueda desincronizar.
function proyeccionMes(eventos, negocio) {
  return proyeccionPeriodo(eventos, negocio, "mes");
}

function barraSemana(dias7) {
  const max = Math.max(1, ...dias7);
  const nombresDias = [];
  const ahora = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(ahora);
    d.setDate(d.getDate() - i);
    nombresDias.push(d.toLocaleDateString("es-CO", { weekday: "short" }));
  }
  return dias7
    .map((v, i) => {
      const alturaPx = 6 + Math.round((v / max) * 46);
      return `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:8px;flex:1;height:100%;">
          <div style="font-size:0.75rem;font-weight:700;color:${MARCA.textoSuave};line-height:1;">${v}</div>
          <div style="width:100%;max-width:22px;height:${alturaPx}px;background:#0F5132;border-radius:4px 4px 0 0;"></div>
          <div style="font-size:0.62rem;color:#999;text-transform:capitalize;line-height:1;">${nombresDias[i]}</div>
        </div>`;
    })
    .join("");
}

// Gráfica de 24 barras (una por hora) para mostrar los picos de actividad del
// día. Se usa en el panel del negocio junto a analizarHoras().
function barraHoras(porHora, picoHora) {
  const max = Math.max(1, ...porHora);
  return porHora
    .map((v, h) => {
      const alturaPx = 4 + Math.round((v / max) * 64);
      const color = h === picoHora && v > 0 ? MARCA.oro : MARCA.verde;
      return `<div style="flex:1;height:${alturaPx}px;background:${color};border-radius:2px 2px 0 0;" title="${h}:00 — ${v} toques"></div>`;
    })
    .join("");
}

// Gráfica de línea con área rellena (SVG) — puramente visual, se le pasa un
// arreglo de valores ya calculados en otro lado (ej. calendario.dias) y solo
// dibuja la curva; no calcula ni inventa ningún dato nuevo.
function graficaLinea(valores, { alto = 90, color = MARCA.verde } = {}) {
  const datos = valores && valores.length ? valores : [0];
  const max = Math.max(1, ...datos);
  const ancho = 100; // porcentual, escala con el contenedor vía viewBox
  const paso = datos.length > 1 ? ancho / (datos.length - 1) : 0;
  const puntos = datos.map((v, i) => {
    const x = i * paso;
    const y = alto - (v / max) * (alto - 10) - 5;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const lineaPath = "M" + puntos.join(" L");
  const areaPath = `${lineaPath} L${ancho},${alto} L0,${alto} Z`;
  // Puntos cada pocos días para no saturar la línea con un punto por dato —
  // el mismo efecto visual "punteado" de un dashboard pulido, sin perder
  // legibilidad cuando hay 30 o más valores.
  const saltoPuntos = Math.max(1, Math.ceil(datos.length / 12));
  const marcadores = puntos
    .map((p, i) => (i % saltoPuntos === 0 || i === puntos.length - 1 ? p : null))
    .filter(Boolean)
    .map((p) => {
      const [cx, cy] = p.split(",");
      return `<circle cx="${cx}" cy="${cy}" r="1.6" fill="${color}" vector-effect="non-scaling-stroke"/>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${ancho} ${alto}" preserveAspectRatio="none" style="width:100%;height:${alto}px;display:block;">
    <path d="${areaPath}" fill="${color}" opacity="0.12" stroke="none"/>
    <path d="${lineaPath}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${marcadores}
  </svg>`;
}

function registrarToque(slug, req, negocio, codigoTarjeta = null) {
  const datos = leerDatos();
  if (!datos[slug]) {
    datos[slug] = { total: 0, eventos: [] };
  }

  const ahora = new Date();
  const tz = zonaDe(negocio);

  const evento = {
    fechaISO: ahora.toISOString(), // fecha exacta en formato estándar (para guardar/exportar)
    fechaLegible: ahora.toLocaleString("es-CO", { timeZone: tz }), // ej: 27/6/2026, 9:14:32 a. m. (hora local del negocio)
    dispositivo: detectarDispositivo(req.headers["user-agent"]),
    // Qué tarjeta física originó este toque (puede ser la principal o una
    // vinculada) — permite comparar actividad entre tarjetas del mismo local.
    codigoTarjeta: codigoTarjeta || slug,
  };

  datos[slug].total += 1;
  datos[slug].eventos.push(evento);

  // Para no crecer infinito, guardamos los últimos 2000 eventos por negocio
  if (datos[slug].eventos.length > 2000) {
    datos[slug].eventos = datos[slug].eventos.slice(-2000);
  }

  guardarDatos(datos);
  return evento;
}

function guardarTestimonio(slug, frase, valor, negocio, codigoTarjeta = null) {
  const datos = leerDatos();
  if (!datos[slug]) datos[slug] = { total: 0, eventos: [] };
  if (!datos[slug].testimonios) datos[slug].testimonios = [];
  const ahora = new Date();
  datos[slug].testimonios.push({
    fechaISO: ahora.toISOString(),
    fechaLegible: ahora.toLocaleString("es-CO", { timeZone: zonaDe(negocio) }),
    frase,
    valor,
    codigoTarjeta: codigoTarjeta || slug,
  });
  guardarDatos(datos);
}

// Promedio de las calificaciones positivas que sí pasan el filtro de Tapin.
// Las quejas privadas no se mezclan porque no son reseñas publicadas.
function promedioEstrellasFiltradas(testimonios, quejas = []) {
  const valores = [...(testimonios || []), ...(quejas || [])]
    .map((t) => t.valor == null && Object.prototype.hasOwnProperty.call(t, "comentario") ? 3 : Number(t.valor))
    .filter((v) => Number.isFinite(v) && v >= 1 && v <= 5);
  if (!valores.length) return null;
  return Math.round((valores.reduce((suma, valor) => suma + valor, 0) / valores.length) * 10) / 10;
}

function guardarQueja(slug, comentario, negocio, telefono = "", valor = null, codigoTarjeta = null) {
  const datos = leerDatos();
  if (!datos[slug]) datos[slug] = { total: 0, eventos: [] };
  if (!datos[slug].quejas) datos[slug].quejas = [];
  const ahora = new Date();
  datos[slug].quejas.push({
    fechaISO: ahora.toISOString(),
    fechaLegible: ahora.toLocaleString("es-CO", { timeZone: zonaDe(negocio) }),
    comentario,
    telefono,
    valor: Number.isFinite(Number(valor)) && Number(valor) >= 1 && Number(valor) <= 5 ? Number(valor) : null,
    estado: "pendiente", // pendiente | contactado | resuelto
    codigoTarjeta: codigoTarjeta || slug,
  });
  guardarDatos(datos);

  // Alerta instantánea (solo Pro): el dueño se entera de la queja apenas
  // llega, no hasta el reporte mensual. No bloquea la respuesta al cliente
  // si el correo falla — es un "fire and forget" a propósito. Solo se manda
  // al instante si el negocio eligió frecuencia "instantánea" — si eligió
  // resumen diario o semanal, esta queja se junta con las demás y se manda
  // agrupada desde /enviar-resumenes-quejas (ver más abajo).
  const frecuenciaQuejas = (negocio.alertas && negocio.alertas.frecuenciaQuejas) || "instantanea";
  const quiereAlertas = (!negocio.alertas || negocio.alertas.quejas !== false) && frecuenciaQuejas === "instantanea";
  if (esPro(negocio) && negocio.email && quiereAlertas) {
    enviarEmail(
      negocio.email,
      `⚠️ Nueva queja privada en ${negocio.nombre}`,
      `<p>Un cliente dejó una calificación negativa y este comentario privado:</p>
       <p style="background:#F8F4EC;padding:14px;border-radius:8px;">"${escaparHtml(comentario)}"</p>
       ${telefono ? `<p>Teléfono de contacto: <b>${escaparHtml(telefono)}</b></p>` : ""}
       <p>Puedes verla y marcarla como contactada/resuelta en tu panel Pro.</p>`
    ).catch((err) => console.error("[alerta queja] Error enviando correo:", err.message));
  }
}

// Genera recomendaciones automáticas simples (reglas si-entonces) a partir de los
// datos ya calculados — esto es lo que convierte "te muestro números" en
// "te doy un consejo basado en tus números" (punto 8).
function generarRecomendaciones(eventos, r, negocio) {
  const recos = [];
  const tz = zonaDe(negocio);

  // Regla 1: comparación semana actual vs. semana anterior
  const ahora = new Date();
  const inicioHoy = new Date(ahora);
  inicioHoy.setHours(0, 0, 0, 0);
  const inicioSemanaAnterior = new Date(inicioHoy);
  inicioSemanaAnterior.setDate(inicioSemanaAnterior.getDate() - 13);
  const finSemanaAnterior = new Date(inicioHoy);
  finSemanaAnterior.setDate(finSemanaAnterior.getDate() - 6);

  let semanaAnterior = 0;
  for (const e of eventos) {
    const f = new Date(e.fechaISO);
    if (f >= inicioSemanaAnterior && f < finSemanaAnterior) semanaAnterior++;
  }

  if (semanaAnterior > 0) {
    const cambio = (r.semana - semanaAnterior) / semanaAnterior;
    if (cambio <= -0.3) {
      recos.push(
        `Tu actividad bajó ${Math.round(Math.abs(cambio) * 100)}% esta semana comparado con la anterior. Revisa si la tarjeta sigue visible y en buen estado.`
      );
    } else if (cambio >= 0.3) {
      recos.push(
        `Tu actividad subió ${Math.round(cambio * 100)}% esta semana comparado con la anterior. Lo que estás haciendo está funcionando, sigue así.`
      );
    }
  }

  // Regla 2: inactividad reciente
  if (r.ultimo) {
    const diasSinToque = Math.floor((ahora - new Date(r.ultimo.fechaISO)) / 86400000);
    if (diasSinToque >= 3) {
      recos.push(
        `Llevas ${diasSinToque} días sin ningún toque registrado. Confirma que la tarjeta esté en un lugar visible y que el chip no esté dañado.`
      );
    }
  } else {
    recos.push("Todavía no se ha registrado ningún toque. Confirma que la tarjeta esté colocada en un lugar visible para tus clientes.");
  }

  // Regla 3: hora/día pico de la semana, usando la hora LOCAL del negocio (no la del servidor)
  const conteoPorDiaHora = {};
  for (const e of eventos) {
    const f = new Date(e.fechaISO);
    const dia = f.toLocaleDateString("es-CO", { timeZone: tz, weekday: "long" });
    const horaLocal = parseInt(f.toLocaleString("es-CO", { timeZone: tz, hour: "2-digit", hour12: false }), 10);
    const bloque = horaLocal < 12 ? "en la mañana" : horaLocal < 18 ? "en la tarde" : "en la noche";
    const clave = `${dia} ${bloque}`;
    conteoPorDiaHora[clave] = (conteoPorDiaHora[clave] || 0) + 1;
  }
  const entradas = Object.entries(conteoPorDiaHora).sort((a, b) => b[1] - a[1]);
  if (entradas.length > 0 && entradas[0][1] >= 3) {
    recos.push(`Tu momento de mayor actividad es ${entradas[0][0]}. Considera reforzar al personal para pedir reseñas en ese horario.`);
  }

  if (recos.length === 0) {
    recos.push("Todo se ve estable. Sigue usando la tarjeta con normalidad.");
  }

  return recos;
}

// Junta los negocios configurados a mano (NEGOCIOS) con los activados por código.
// Se usa en el panel principal y en las comparaciones de sector.
function todosLosNegocios() {
  const codigos = leerCodigos();
  const dinamicos = {};
  for (const codigo in codigos) {
    if (codigos[codigo].desactivado) continue;
    if (codigos[codigo].activado && codigos[codigo].negocio) {
      dinamicos[codigo] = {
        ...codigos[codigo].negocio,
        // Compatibilidad con tarjetas activadas antes de guardar la clave.
        // Conserva la clave existente y solo crea una de respaldo si falta.
        claveAcceso: codigos[codigo].negocio.claveAcceso || codigos[codigo].claveAcceso || `${codigo.toLowerCase()}-panel`,
      };
    }
  }
  const resultado = { ...NEGOCIOS, ...dinamicos };
  for (const slug in codigos) {
    if (codigos[slug].desactivado) delete resultado[slug];
  }
  return resultado;
}

// Calcula el promedio de toques (últimos 7 días) de los negocios de la misma categoría,
// excluyendo al propio negocio. Sirve para el comparativo "vs. promedio del sector" (punto 9).
function promedioSector(categoria, slugActual, datos) {
  const todos = todosLosNegocios();
  const pares = Object.entries(todos).filter(
    ([slug, n]) => n.categoria === categoria && slug !== slugActual
  );
  // Con menos de 2 negocios parecidos, "el promedio del sector" sería en
  // realidad el dato de un solo competidor puntual — no lo mostramos para
  // no exponer a nadie sin querer.
  if (pares.length < 2) return null;
  const total = pares.reduce((acc, [slug]) => {
    const eventos = (datos[slug] && datos[slug].eventos) || [];
    return acc + calcularResumen(eventos).semana;
  }, 0);
  return Math.round(total / pares.length);
}

// Radar de sector: además del tráfico (lo que ya hacía promedioSector),
// compara calificación promedio, tasa de conversión (toques -> reseñas) y
// tasa de resolución de quejas contra el promedio de negocios de la misma
// categoría. Mismo piso de privacidad: con menos de 2 negocios parecidos,
// no se muestra nada — un "promedio" de un solo negocio lo identifica
// directamente.
function radarSector(negocio, slug, todosNegocios, datos) {
  const pares = Object.entries(todosNegocios).filter(
    ([s, n]) => n.categoria === negocio.categoria && s !== slug
  );
  if (pares.length < 2) return null;

  const metricasDe = (s) => {
    const eventos = (datos[s] && datos[s].eventos) || [];
    const testimonios = (datos[s] && datos[s].testimonios) || [];
    const quejas = (datos[s] && datos[s].quejas) || [];
    const r = calcularResumen(eventos);
    const totalResenas = testimonios.length + quejas.length;
    return {
      trafico: r.semana,
      calificacion: promedioEstrellasFiltradas(testimonios, quejas),
      conversion: r.total > 0 ? totalResenas / r.total : null,
      resolucion: quejas.length > 0 ? quejas.filter((q) => q.estado === "resuelto").length / quejas.length : null,
    };
  };

  const promedioDe = (valores) => {
    const validos = valores.filter((v) => v !== null && Number.isFinite(v));
    if (!validos.length) return null;
    return validos.reduce((a, b) => a + b, 0) / validos.length;
  };

  const propio = metricasDe(slug);
  const delSector = pares.map(([s]) => metricasDe(s));

  return {
    negociosComparados: pares.length,
    trafico: { propio: propio.trafico, sector: promedioDe(delSector.map((m) => m.trafico)) },
    calificacion: { propio: propio.calificacion, sector: promedioDe(delSector.map((m) => m.calificacion)) },
    conversion: { propio: propio.conversion, sector: promedioDe(delSector.map((m) => m.conversion)) },
    resolucion: { propio: propio.resolucion, sector: promedioDe(delSector.map((m) => m.resolucion)) },
  };
}

// Lista blanca de frases válidas de testimonio — se usa tanto para mostrar
// los chips en /calificar como para VALIDAR que lo que llega a /testimonio
// (que viaja como parámetro en la URL) sea de verdad una de estas frases y
// no texto arbitrario. Sin esto, alguien podría armar un link con cualquier
// texto en "?frase=" y ese texto terminaría metido sin control en el prompt
// que le mandamos a la IA para generar el caption (inyección de prompt).
const FRASES_POR_CATEGORIA = {
  restaurante: ["Excelente atención", "Muy buena comida", "Ambiente increíble", "Rápido y eficiente", "Lo recomiendo 100%", "Volveré seguro"],
  peluqueria: ["Excelente atención", "Quedé feliz con el resultado", "Ambiente muy agradable", "Rápido y puntual", "Lo recomiendo 100%", "Volveré seguro"],
  tienda: ["Excelente atención", "Buenos precios", "Gran variedad", "Rápido y eficiente", "Lo recomiendo 100%", "Volveré seguro"],
  clinica: ["Excelente atención", "Muy profesionales", "Instalaciones impecables", "Puntualidad", "Lo recomiendo 100%", "Volveré seguro"],
  otro: ["Excelente atención", "Muy buen servicio", "Ambiente increíble", "Rápido y eficiente", "Lo recomiendo 100%", "Volveré seguro"],
};
const TODAS_LAS_FRASES_VALIDAS = new Set(Object.values(FRASES_POR_CATEGORIA).flat());

// ---------- Rutas ----------

// Esta es la URL que se programa en el chip NFC de la tarjeta Tapin.
// Plan Pro: primero muestra una pantalla rápida de "¿cómo te fue?" — si la
// respuesta es positiva, lo manda a Google; si es negativa, lo manda a un
// formulario privado en vez de exponerlo en público. Es el "filtro de
// calificaciones", exclusivo de Pro (así está listado en /precios).
// Plan Básico: NO tiene ese filtro — va directo a Google sin pantalla
// intermedia, sin importar qué calificación hubiera dado el cliente.
// Ejemplo: https://tu-dominio.com/r/mi-negocio
app.get("/r/:slug", (req, res) => {
  const codigoTarjeta = req.params.slug; // el código físico exacto que se tocó
  const slug = resolverSlug(codigoTarjeta); // el negocio al que pertenece (puede ser el mismo, o el principal si está vinculada)
  const negocio = obtenerNegocio(slug);

  if (!negocio) {
    const codigos = leerCodigos();
    if (codigos[slug] && !codigos[slug].activado) {
      return res.redirect(302, `/mis-negocios?codigo=${slug}`);
    }
    return enviarError(res, 404, "No encontramos este negocio", "El enlace de esta tarjeta no corresponde a ningún negocio activo. Si acabas de recibir la tarjeta, puede que todavía no esté activada.");
  }

  registrarToque(slug, req, negocio, codigoTarjeta);

  // Plan Básico: sin filtro de calificaciones — directo a Google siempre.
  if (!esPro(negocio)) {
    return res.redirect(302, negocio.googleUrl);
  }

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${negocio.nombre}</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#F8F4EC;
               display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
          .box{background:#fff;border-radius:18px;padding:36px 28px;max-width:380px;width:100%;
               text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.08);}
          h1{font-size:1.25rem;margin:0 0 6px;color:#16201C;}
          p{color:#777;font-size:0.92rem;margin:0 0 28px;}
          .caras{display:flex;flex-direction:column;gap:8px;}
          .caras a{text-decoration:none;padding:12px 16px;border-radius:12px;background:#F8F4EC;
                    transition:transform .15s;display:flex;justify-content:center;gap:4px;}
          .caras a:active{transform:scale(0.96);}
          .caras svg{display:block;}
        </style>
      </head>
      <body>
        <div class="box">
          <h1>${negocio.nombre}</h1>
          <p>¿Cómo te fue con nosotros hoy?</p>
          <div class="caras">
            ${[5, 4, 3, 2, 1]
              .map((n) => {
                const estrella = (llena) => `
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="${llena ? MARCA.oro : "none"}"
                       stroke="${MARCA.oro}" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 2.5l2.9 6.06 6.6.77-4.86 4.55 1.28 6.55L12 17.3l-5.92 3.13 1.28-6.55L2.5 9.33l6.6-.77L12 2.5z"/>
                  </svg>`;
                return `<a href="/calificar/${codigoTarjeta}?valor=${n}" aria-label="${n} estrella${n > 1 ? "s" : ""}">
                  ${[1, 2, 3, 4, 5].map((i) => estrella(i <= n)).join("")}
                </a>`;
              })
              .join("")}
          </div>
        </div>
      </body>
    </html>
  `);
});

// Procesa la calificación: si es positiva (4-5), va a Google.
// Si es negativa (1-3), se guarda como queja privada y se le pide el detalle al cliente
// en vez de exponer la insatisfacción en una reseña pública.
app.get("/calificar/:slug", (req, res) => {
  const codigoTarjeta = req.params.slug;
  const slug = resolverSlug(codigoTarjeta);
  const negocio = obtenerNegocio(slug);
  if (!negocio) return enviarError(res, 404, "No encontramos este negocio", "El enlace que usaste no corresponde a ningún negocio activo en Tapin.");

  const valor = parseInt(req.query.valor, 10);
  let selloSumado = null; // se usa más abajo para avisarle al cliente si aplica

  // Red de seguridad: el filtro de calificaciones es exclusivo de Pro. Si el
  // negocio ya no es Pro (por ejemplo, bajó de plan y quedó un link viejo de
  // /calificar guardado en algún lado), no se muestra el formulario privado
  // — se manda directo a Google, igual que si nunca hubiera pasado por aquí.
  if (!esPro(negocio)) {
    return res.redirect(302, negocio.googleUrl);
  }

  // Si el cliente tiene sesión iniciada, guardamos esta calificación en su
  // historial personal — funciona sin importar si el negocio es Pro o básico.
  if (valor >= 1 && valor <= 5) {
    const cliente = clienteActual(req);
    if (cliente) {
      const clientes = leerClientes();
      if (clientes[cliente.id]) {
        if (!clientes[cliente.id].historial) clientes[cliente.id].historial = [];
        clientes[cliente.id].historial.push({
          slug,
          negocioNombre: negocio.nombre,
          valor,
          fecha: new Date().toLocaleDateString("es-CO", { timeZone: zonaDe(negocio), day: "numeric", month: "long", year: "numeric" }),
          fechaISO: new Date().toISOString(),
        });
        guardarClientes(clientes);
      }
      // Idea: la fidelización ya no necesita una tarjeta física aparte — con
      // solo calificar (cualquier estrella, no solo positivas) desde la
      // misma tarjeta de reseñas, si tiene sesión iniciada, ya suma el sello.
      if (esPro(negocio) && negocio.fidelizacion) {
        selloSumado = sumarSelloFidelizacion(slug, negocio, cliente.email, cliente.nombre);
      }
    }
  }

  if (valor >= 4) {
    // Calificación positiva (4-5): directo a Google, sin pantallas ni
    // preguntas intermedias — ni siquiera en Plan Pro.
    return res.redirect(302, negocio.googleUrl);
  }

  // Calificación negativa: mostramos un formulario privado en vez de mandarlo a Google.
  // Los motivos varían según la categoría del negocio — un restaurante y una
  // peluquería no tienen los mismos problemas típicos.
  const motivosPorCategoria = {
    restaurante: ["Atención lenta", "Comida fría o mal preparada", "Precio alto", "Local sucio", "Pedido incorrecto", "Otro"],
    peluqueria: ["Espera muy larga", "No quedé conforme con el resultado", "Precio alto", "Mala actitud", "Local sucio", "Otro"],
    tienda: ["Atención lenta", "Producto no era lo esperado", "Precio alto", "Local desordenado", "Mala actitud", "Otro"],
    clinica: ["Espera muy larga", "Mala actitud del personal", "Precio alto", "Instalaciones sucias", "Atención poco clara", "Otro"],
    otro: ["Atención lenta", "Mala actitud", "Precio alto", "Local sucio", "Producto no era lo esperado", "Otro"],
  };
  const motivosNegativos = motivosPorCategoria[negocio.categoria] || motivosPorCategoria.otro;
  const chipsNegativos = motivosNegativos
    .map((m) => `<a href="/calificar/${codigoTarjeta}/rapido?valor=${valor}&motivo=${encodeURIComponent(m)}" class="chip">${m}</a>`)
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Cuéntanos más</title>
        <style>
          body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#F8F4EC;
               display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
          .box{background:#fff;border-radius:18px;padding:32px 26px;max-width:380px;width:100%;
               box-shadow:0 10px 30px rgba(0,0,0,0.08);}
          h1{font-size:1.15rem;color:#16201C;margin:0 0 8px;}
          p{color:#777;font-size:0.9rem;margin:0 0 18px;}
          .chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:22px;}
          .chip{background:#FBEFE9;color:#993C1D;border:1px solid #F0D5C8;border-radius:100px;
                padding:10px 14px;font-size:0.85rem;font-weight:600;text-decoration:none;}
          .chip:active{transform:scale(0.96);}
          .divisor{display:flex;align-items:center;gap:10px;margin:4px 0 16px;color:#aaa;font-size:0.76rem;}
          .divisor::before,.divisor::after{content:"";flex:1;height:1px;background:#eee;}
          textarea{width:100%;border:1px solid #ddd;border-radius:10px;padding:12px;font-size:0.95rem;
                    min-height:70px;font-family:inherit;box-sizing:border-box;}
          button{margin-top:14px;width:100%;background:#1F6E4E;color:#fff;border:none;border-radius:10px;
                 padding:13px;font-size:0.95rem;font-weight:600;cursor:pointer;}
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Lamentamos que tu visita no haya sido perfecta</h1>
          <p>Cuéntanos qué pasó (toca una, es lo más rápido) — esto llega directo al negocio, no se publica en ningún lado.</p>
          <div class="chips">${chipsNegativos}</div>

          <div class="divisor">o cuéntanos con tus palabras</div>
          <form method="POST" action="/calificar/${codigoTarjeta}">
            <input type="hidden" name="valor" value="${valor}">
            <textarea name="comentario" placeholder="Escribe aquí lo que pasó... (opcional)"></textarea>
            <input type="tel" name="telefono" placeholder="Tu teléfono (opcional, para que te llamen)" style="width:100%;margin-top:10px;padding:12px;border:1px solid #ddd;border-radius:10px;font-size:0.92rem;font-family:inherit;box-sizing:border-box;">
            <button type="submit">Enviar</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

// Igual que /testimonio para los positivos, pero para el lado negativo: un
// solo toque en un motivo corto guarda la queja de una vez, sin tener que
// escribir nada. Mucho más rápido, así no se pierden clientes por pereza de teclear.
app.get("/calificar/:slug/rapido", (req, res) => {
  const codigoTarjeta = req.params.slug;
  const slug = resolverSlug(codigoTarjeta);
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  const motivo = req.query.motivo || "(sin detalle)";
  const valorRapido = parseInt(req.query.valor, 10) || null;
  guardarQueja(slug, motivo, negocio, "", valorRapido, codigoTarjeta);

  // La fidelización premia la VISITA, no solo las reseñas positivas — si el
  // cliente tiene sesión iniciada, suma su sello igual que en una calificación buena.
  let selloSumado = null;
  if (esPro(negocio) && negocio.fidelizacion) {
    const cliente = clienteActual(req);
    if (cliente) selloSumado = sumarSelloFidelizacion(slug, negocio, cliente.email, cliente.nombre);
  }

  res.send(`
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font-family:-apple-system,sans-serif;background:#F8F4EC;display:flex;align-items:center;
    justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;color:#16201C;}
    .box{background:#fff;border-radius:18px;padding:36px 28px;max-width:380px;box-shadow:0 10px 30px rgba(0,0,0,0.08);}
    .sello-aviso{background:#FBF6E9;border-radius:10px;padding:10px 14px;font-size:0.8rem;color:#7A5A00;margin-top:14px;}
    </style></head>
    <body><div class="box"><h2>Gracias por avisarnos</h2><p>El negocio ya recibió tu comentario y lo va a revisar.</p>
    ${selloSumado ? `<div class="sello-aviso">${selloSumado.listo ? `¡Beneficio desbloqueado! Ya tienes: ${selloSumado.fid.premio}` : `+1 sello de fidelización — llevas ${selloSumado.actual.sellos} de ${selloSumado.fid.metaSellos}`}</div>` : ""}
    </div></body></html>
  `);
});

app.post("/calificar/:slug", async (req, res) => {
  const codigoTarjeta = req.params.slug;
  const slug = resolverSlug(codigoTarjeta);
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  const comentario = req.body.comentario || "(sin comentario)";
  const telefono = req.body.telefono || "";
  const valorTexto = parseInt(req.body.valor, 10) || null;
  guardarQueja(slug, comentario, negocio, telefono, valorTexto, codigoTarjeta);

  let selloSumado = null;
  if (esPro(negocio) && negocio.fidelizacion) {
    const cliente = clienteActual(req);
    if (cliente) selloSumado = sumarSelloFidelizacion(slug, negocio, cliente.email, cliente.nombre);
  }

  // Alerta inmediata por correo — solo Plan Pro. El negocio básico igual evita
  // que la queja se publique en Google, pero no recibe el aviso instantáneo.
  if (esPro(negocio)) {
    const horaLocal = new Date().toLocaleString("es-CO", { timeZone: zonaDe(negocio) });
    enviarEmail(
      negocio.email,
      `🚨 Cliente insatisfecho en ${negocio.nombre} — actúa ahora`,
      `
        <div style="font-family:-apple-system,Arial,sans-serif;max-width:480px;">
          <h2 style="color:#C0392B;margin-bottom:4px;">Un cliente no tuvo una buena experiencia</h2>
          <p style="color:#666;font-size:0.9rem;margin-top:0;">${horaLocal}</p>
          <div style="background:#FBEFE9;border-left:3px solid #C0392B;padding:14px 16px;border-radius:8px;margin:16px 0;">
            <p style="margin:0;color:#16201C;">"${escaparHtml(comentario)}"</p>
          </div>
          ${telefono ? `<p><b>Teléfono para contactarlo:</b> <a href="tel:${encodeURIComponent(telefono)}">${escaparHtml(telefono)}</a></p>` : `<p style="color:#888;">No dejó teléfono de contacto.</p>`}
          <p style="font-size:0.85rem;color:#888;margin-top:24px;">Entre más rápido respondas, más probable es convertir esto en un cliente recuperado en vez de una reseña negativa pública.</p>
        </div>
      `
    ).catch(() => {});
  }

  res.send(`
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font-family:-apple-system,sans-serif;background:#F8F4EC;display:flex;align-items:center;
    justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;color:#16201C;}
    .box{background:#fff;border-radius:18px;padding:36px 28px;max-width:380px;box-shadow:0 10px 30px rgba(0,0,0,0.08);}
    .sello-aviso{background:#FBF6E9;border-radius:10px;padding:10px 14px;font-size:0.8rem;color:#7A5A00;margin-top:14px;}
    </style></head>
    <body><div class="box"><h2>Gracias por avisarnos 🙏</h2><p>El negocio ya recibió tu comentario y lo va a revisar.</p>
    ${selloSumado ? `<div class="sello-aviso">${selloSumado.listo ? `¡Beneficio desbloqueado! Ya tienes: ${selloSumado.fid.premio}` : `+1 sello de fidelización — llevas ${selloSumado.actual.sellos} de ${selloSumado.fid.metaSellos}`}</div>` : ""}
    </div></body></html>
  `);
});

// Guarda el micro-testimonio elegido con un solo toque y manda al cliente a Google.
app.get("/testimonio/:slug", (req, res) => {
  const codigoTarjeta = req.params.slug;
  const slug = resolverSlug(codigoTarjeta);
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  const frase = req.query.frase || "";
  const valor = parseInt(req.query.valor, 10) || 5;
  // Solo se guarda si es EXACTAMENTE una de las frases predefinidas — nunca
  // texto libre. Esto es lo que evita que alguien arme un link con cualquier
  // cosa en "?frase=" y ese texto termine sin control dentro del prompt que
  // se le manda a la IA más adelante, al generar el caption de esa tarjeta.
  if (frase && esPro(negocio) && TODAS_LAS_FRASES_VALIDAS.has(frase)) guardarTestimonio(slug, frase, valor, negocio, codigoTarjeta);

  res.redirect(302, negocio.googleUrl);
});

// Panel visual: una tarjeta por negocio con totales de hoy, semana, y mini gráfica.
// Visítalo así: https://tu-dominio.com/stats?key=TU_CLAVE
// Panel de generación y administración de códigos de activación.
// Genera un código por cada tarjeta física ANTES de saber a qué negocio va.
// Visítalo así: https://tu-dominio.com/codigos?key=TU_CLAVE
// Página para crear y editar negocios directamente desde el navegador,
// sin tener que tocar el código ni redesplegar en Render.
// Visítalo así: https://tu-dominio.com/editar?key=TU_CLAVE
app.get("/editar", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const key = req.query.key;
  const todos = todosLosNegocios();
  const codigosTodos = leerCodigos();

  const filas = Object.entries(todos)
    .map(([slug, n]) => {
      const vinculadas = tarjetasVinculadasA(slug, codigosTodos);
      return `<tr>
        <td><b>${n.nombre}</b></td>
        <td><code class="codigo">/r/${slug}</code></td>
        <td>${n.categoria || "—"}</td>
        <td>${vinculadas.length ? `${1 + vinculadas.length} tarjetas` : "1 tarjeta"}</td>
        <td><a href="/editar/${slug}?key=${key}">Editar</a> &nbsp;·&nbsp; <a href="/editar/${slug}/quitar?key=${key}" style="color:${MARCA.rojo};">Quitar</a></td>
      </tr>`;
    })
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Editar negocios — Tapin</title>
        <style>
          ${ESTILO_BASE}
          table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid ${MARCA.borde};}
          th,td{padding:12px 16px;text-align:left;font-size:0.86rem;border-bottom:1px solid ${MARCA.borde};}
          th{background:${MARCA.verdeOscuro};color:#fff;font-size:0.74rem;text-transform:uppercase;letter-spacing:0.04em;}
          .codigo{background:${MARCA.verdeClaro};padding:3px 8px;border-radius:6px;font-family:monospace;}
          a{font-weight:600;text-decoration:none;}
          .btn-nuevo{display:inline-block;background:${MARCA.verdeOscuro};color:#fff;padding:11px 20px;border-radius:9px;
                     font-weight:700;font-size:0.88rem;text-decoration:none;margin-bottom:20px;}
          .btn-nuevo:hover{background:${MARCA.verde};}
        </style>
      </head>
      <body>
        <div class="topbar">
          <div>${logoSvg("#FFFFFF", 30)}</div>
          <a class="back" href="/stats?key=${key}">&larr; Volver al panel</a>
        </div>
        <div class="content">
          <div class="eyebrow">Administración</div>
          <h1 class="titulo-pagina">Negocios</h1>
          <div class="subtitulo">Crea o edita negocios directamente, sin tocar código.</div>

          <a class="btn-nuevo" href="/editar/nuevo?key=${key}">+ Agregar negocio nuevo</a>

          ${req.query.claveNueva ? `
          <div style="background:${MARCA.verdeClaro};color:${MARCA.verdeOscuro};border-radius:10px;padding:14px 18px;margin-bottom:20px;font-size:0.86rem;">
            <b>Negocio "${req.query.slugNuevo}" creado.</b> Su clave de panel es: <code style="background:#fff;padding:2px 8px;border-radius:6px;">${escaparHtml(req.query.claveNueva)}</code>
            — apúntala ahora, no se vuelve a mostrar (queda cifrada de aquí en adelante).
          </div>
          ` : ""}

          <table>
            <tr><th>Nombre</th><th>Enlace de toque</th><th>Categoría</th><th>Tarjetas</th><th></th></tr>
            ${filas || "<tr><td colspan='5'>Todavía no hay negocios.</td></tr>"}
          </table>
        </div>
      </body>
    </html>
  `);
});

// Formulario para crear un negocio nuevo directamente (sin pasar por código de activación).
app.get("/editar/nuevo", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const key = req.query.key;
  res.send(formularioNegocio({ titulo: "Agregar negocio nuevo", accion: `/editar/nuevo?key=${key}`, key }));
});

app.post("/editar/nuevo", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const { nombre, googleUrl, categoria, pais, email, plan, direccion, lat, lng } = req.body;
  if (!nombre || !googleUrl) {
    return res.status(400).send("Faltan datos: nombre y enlace de Google son obligatorios.");
  }

  const codigos = leerCodigos();
  let slug;
  do {
    slug = generarCodigo();
  } while (codigos[slug] || NEGOCIOS[slug]);

  const claveGenerada = `${slug.toLowerCase()}-panel`;
  const { salt: saltNuevo, hash: hashNuevo } = hashClaveNegocio(claveGenerada);
  codigos[slug] = {
    activado: true,
    creado: new Date().toISOString(),
    activadoEl: new Date().toISOString(),
    negocio: {
      nombre,
      googleUrl,
      categoria: categoria || "otro",
      pais: pais || "colombia",
      claveAccesoHash: hashNuevo,
      claveAccesoSalt: saltNuevo,
      email: email || "",
      plan: plan === "pro" ? "pro" : "basico",
      direccion: direccion || "",
      lat: lat ? parseFloat(lat) : null,
      lng: lng ? parseFloat(lng) : null,
    },
  };
  guardarCodigos(codigos);
  registrarAuditoriaGlobal("crear_negocio", `Negocio "${nombre}" (${slug}) creado directamente desde /editar/nuevo`, req);

  res.redirect(`/editar?key=${req.query.key}&claveNueva=${encodeURIComponent(claveGenerada)}&slugNuevo=${slug}`);
});

// Editar un negocio dinámico existente (creado por código de activación o desde /editar/nuevo).
app.get("/editar/:slug", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const codigosGetEditar = leerCodigos();
  const slug = resolverSlug(req.params.slug, codigosGetEditar);
  // Si alguien entra con el código de una tarjeta vinculada, lo mandamos al
  // negocio principal — así nunca se edita/guarda por accidente sobre una
  // tarjeta que no tiene su propio objeto "negocio".
  if (slug !== req.params.slug) {
    return res.redirect(`/editar/${slug}?key=${req.query.key}`);
  }
  const negocio = obtenerNegocio(slug);
  if (!negocio) {
    return res.status(404).send("Negocio no encontrado.");
  }
  const key = req.query.key;
  const vinculadas = tarjetasVinculadasA(slug, codigosGetEditar).map((c) => ({ codigo: c, etiqueta: (codigosGetEditar[c] && codigosGetEditar[c].etiqueta) || null }));
  res.send(formularioNegocio({
    titulo: `Editar — ${negocio.nombre}`,
    accion: `/editar/${slug}?key=${key}`,
    key,
    valores: negocio,
    slug,
    tarjetasVinculadas: vinculadas,
  }));
});

app.post("/editar/:slug", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const slug = resolverSlug(req.params.slug);
  if (slug !== req.params.slug) {
    return res.status(400).send("Esta es una tarjeta vinculada, no un negocio propio — edita el negocio principal.");
  }
  const negocioActual = obtenerNegocio(slug);
  if (!negocioActual) {
    return res.status(404).send("Negocio no encontrado.");
  }
  const { nombre, googleUrl, categoria, pais, email, plan, direccion, lat, lng } = req.body;
  if (!nombre || !googleUrl) {
    return res.status(400).send("Faltan datos: nombre y enlace de Google son obligatorios.");
  }

  // Si el negocio venía del código (NEGOCIOS) y aún no tiene override, lo creamos ahora.
  // Esto sobreescribe esa entrada sin tocar server.js ni redesplegar.
  const codigos = leerCodigos();
  if (!codigos[slug]) {
    codigos[slug] = { activado: true, creado: new Date().toISOString() };
  }
  codigos[slug].activado = true;
  codigos[slug].activadoEl = new Date().toISOString();
  // Preserva la clave de acceso tal cual estaba (cifrada o, si es una cuenta
  // vieja, en texto plano) — este formulario no la toca. Solo si el negocio
  // NUNCA tuvo ninguna clave configurada le generamos una por defecto.
  const claveExistente = (codigos[slug].negocio && codigos[slug].negocio.claveAccesoHash) ? {
    claveAccesoHash: codigos[slug].negocio.claveAccesoHash,
    claveAccesoSalt: codigos[slug].negocio.claveAccesoSalt,
  } : negocioActual.claveAccesoHash ? {
    claveAccesoHash: negocioActual.claveAccesoHash,
    claveAccesoSalt: negocioActual.claveAccesoSalt,
  } : (codigos[slug].negocio && codigos[slug].negocio.claveAcceso) ? {
    claveAcceso: codigos[slug].negocio.claveAcceso,
  } : negocioActual.claveAcceso ? {
    claveAcceso: negocioActual.claveAcceso,
  } : (() => {
    const { salt, hash } = hashClaveNegocio(`${slug.toLowerCase()}-panel`);
    return { claveAccesoHash: hash, claveAccesoSalt: salt };
  })();
  codigos[slug].negocio = {
    nombre,
    googleUrl,
    categoria: categoria || "otro",
    pais: pais || negocioActual.pais || "colombia",
    ...claveExistente,
    email: email || negocioActual.email || "",
    plan: plan === "pro" ? "pro" : "basico",
    direccion: direccion || "",
    lat: lat ? parseFloat(lat) : null,
    lng: lng ? parseFloat(lng) : null,
  };
  guardarCodigos(codigos);
  const planCambio = negocioActual.plan !== (plan === "pro" ? "pro" : "basico");
  registrarAuditoriaGlobal(
    "editar_negocio",
    `Negocio "${nombre}" (${slug}) editado desde /editar${planCambio ? ` — plan cambiado de "${negocioActual.plan}" a "${plan === "pro" ? "pro" : "basico"}"` : ""}`,
    req
  );

  res.redirect(`/editar?key=${req.query.key}`);
});
// Pantalla de confirmación antes de quitar una tarjeta (para evitar borrados accidentales).
app.get("/editar/:slug/quitar", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  const key = req.query.key;

  res.send(`
    <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Quitar tarjeta — Tapin</title>
      <style>
        ${ESTILO_BASE}
        .form-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:16px;padding:28px;max-width:460px;}
        .btn-peligro{background:${MARCA.rojo};color:#fff;border:none;border-radius:9px;padding:13px;
                     font-size:0.95rem;font-weight:700;cursor:pointer;width:100%;margin-top:10px;}
        .btn-cancelar{display:block;text-align:center;margin-top:14px;color:${MARCA.textoSuave};font-size:0.85rem;}
      </style></head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div></div>
        <div class="content">
          <div class="eyebrow">Atención</div>
          <h1 class="titulo-pagina">¿Quitar esta tarjeta?</h1>
          <div class="subtitulo">Vas a quitar <b>${negocio.nombre}</b> del panel.</div>
          <div class="form-card">
            <p style="font-size:0.88rem;color:${MARCA.textoSuave};line-height:1.5;">
              La tarjeta deja de redirigir a Google y desaparece del panel. El historial de toques que ya tiene
              <b>no se borra</b> — si más adelante reactivas este código o creas otro negocio con el mismo slug,
              ese historial sigue ahí.
            </p>
            <form method="POST" action="/editar/${slug}/quitar?key=${key}">
              <button type="submit" class="btn-peligro">Sí, quitar esta tarjeta</button>
            </form>
            <a class="btn-cancelar" href="/editar?key=${key}">Cancelar</a>
          </div>
        </div>
      </body>
    </html>
  `);
});

// Procesa la desactivación: la tarjeta deja de funcionar y desaparece del panel,
// pero el historial de toques queda guardado en data.json por si se reactiva después.
app.post("/editar/:slug/quitar", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  const codigos = leerCodigos();
  if (!codigos[slug]) {
    codigos[slug] = { creado: new Date().toISOString() };
  }
  codigos[slug].activado = false;
  codigos[slug].desactivado = true;
  codigos[slug].desactivadoEl = new Date().toISOString();
  guardarCodigos(codigos);
  registrarAuditoriaGlobal("quitar_negocio", `Negocio "${negocio.nombre}" (${slug}) desactivado desde /editar`, req);

  res.redirect(`/editar?key=${req.query.key}`);
});

// Desvincula una tarjeta adicional de su negocio principal — la tarjeta deja
// de sumar datos a ese negocio y vuelve a quedar "sin activar", lista para
// activarse de nuevo (como negocio nuevo, o vinculada a otro distinto).
app.post("/editar/:slugPrincipal/desvincular/:codigo", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const { slugPrincipal, codigo } = req.params;
  const codigos = leerCodigos();
  const entrada = codigos[codigo];
  if (!entrada || entrada.vinculadoA !== slugPrincipal) {
    return res.status(404).send("Esa tarjeta no está vinculada a este negocio.");
  }
  const negocioPrincipal = obtenerNegocio(slugPrincipal);
  codigos[codigo] = { creado: entrada.creado || new Date().toISOString() };
  guardarCodigos(codigos);
  registrarAuditoriaGlobal(
    "desvincular_tarjeta",
    `Tarjeta ${codigo} desvinculada de "${negocioPrincipal ? negocioPrincipal.nombre : slugPrincipal}" (${slugPrincipal}) — queda sin activar`,
    req
  );
  res.redirect(`/editar/${slugPrincipal}?key=${req.query.key}`);
});

// Plantilla reutilizable del formulario de crear/editar negocio.
function formularioNegocio({ titulo, accion, key, valores = {}, slug = null, tarjetasVinculadas = [] }) {
  const categorias = ["restaurante", "peluqueria", "tienda", "clinica", "otro"];
  const opciones = categorias
    .map((c) => `<option value="${c}" ${valores.categoria === c ? "selected" : ""}>${c.charAt(0).toUpperCase() + c.slice(1)}</option>`)
    .join("");

  const paises = {
    colombia: "Colombia",
    panama: "Panamá",
    paraguay: "Paraguay",
    miami: "Estados Unidos (Miami)",
  };
  const opcionesPais = Object.entries(paises)
    .map(([valor, etiqueta]) => `<option value="${valor}" ${valores.pais === valor ? "selected" : ""}>${etiqueta}</option>`)
    .join("");

  return `
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${titulo} — Tapin</title>
        <style>
          ${ESTILO_BASE}
          .form-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:16px;padding:28px;max-width:460px;
                     box-shadow:0 8px 24px rgba(11,61,44,0.06);}
          label{font-size:0.82rem;font-weight:600;color:${MARCA.textoSuave};display:block;margin:14px 0 6px;}
          label:first-of-type{margin-top:0;}
          input,select{width:100%;padding:11px 13px;border:1px solid ${MARCA.borde};border-radius:9px;font-size:0.92rem;font-family:inherit;}
          button{margin-top:22px;width:100%;background:${MARCA.verdeOscuro};color:#fff;border:none;border-radius:9px;
                 padding:13px;font-size:0.95rem;font-weight:700;cursor:pointer;}
          button:hover{background:${MARCA.verde};}
          .quitar-link{display:block;text-align:center;margin-top:16px;color:${MARCA.rojo};font-size:0.84rem;font-weight:600;text-decoration:none;}
        </style>
      </head>
      <body>
        <div class="topbar">
          <div>${logoSvg("#FFFFFF", 30)}</div>
          <a class="back" href="/editar?key=${key}">&larr; Volver</a>
        </div>
        <div class="content">
          <div class="eyebrow">Negocio</div>
          <h1 class="titulo-pagina">${titulo}</h1>
          <div class="subtitulo">Los cambios quedan activos de inmediato, sin redesplegar nada.</div>

          <div class="form-card">
            <form method="POST" action="${accion}">
              <label>Nombre del negocio</label>
              <input type="text" name="nombre" required value="${valores.nombre || ""}" placeholder="Ej: Restaurante La 21">

              <label>Enlace de reseñas de Google</label>
              <input type="url" name="googleUrl" required value="${valores.googleUrl || ""}" placeholder="https://g.page/r/.../review">

              <label>Email del negocio (alertas y reportes llegan aquí)</label>
              <input type="email" name="email" required value="${valores.email || ""}" placeholder="dueno@negocio.com">

              <label>Plan</label>
              <select name="plan">
                <option value="basico" ${valores.plan !== "pro" ? "selected" : ""}>Básico ($119.900 — envío incluido)</option>
                <option value="pro" ${valores.plan === "pro" ? "selected" : ""}>Pro ($59.900/mes — alertas, reporte mensual)</option>
              </select>

              <label>Dirección (aparece en el mapa público de /descubre)</label>
              <input type="text" name="direccion" value="${valores.direccion || ""}" placeholder="Cra 7 # 12-34, Chía">

              <label>Latitud (opcional, para el mapa)</label>
              <input type="text" name="lat" value="${valores.lat != null ? valores.lat : ""}" placeholder="4.8617">

              <label>Longitud (opcional, para el mapa)</label>
              <input type="text" name="lng" value="${valores.lng != null ? valores.lng : ""}" placeholder="-74.0397">

              <label>Categoría</label>
              <select name="categoria">${opciones}</select>

              <label>País (define la hora local de los reportes)</label>
              <select name="pais">${opcionesPais}</select>

              <button type="submit">Guardar</button>
            </form>
            ${slug ? `<a class="quitar-link" href="/editar/${slug}/quitar?key=${key}">Quitar esta tarjeta</a>` : ""}
          </div>

          ${slug ? `
          <div class="form-card" style="margin-top:16px;">
            <h3 style="margin:0 0 4px;font-size:0.92rem;">Tarjetas vinculadas a este negocio</h3>
            <p style="color:${MARCA.textoSuave};font-size:0.8rem;margin:0 0 14px;line-height:1.5;">
              Un mismo local puede tener varias tarjetas físicas (una por mesa, una en la caja, etc.) — todas
              suman al mismo negocio. Identificador de este negocio para vincular tarjetas nuevas: <code style="background:${MARCA.verdeClaro};padding:2px 8px;border-radius:6px;">${slug}</code>
            </p>
            ${tarjetasVinculadas.length
              ? tarjetasVinculadas.map((t) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid ${MARCA.borde};font-size:0.85rem;">
                  <span>${t.etiqueta ? `<b>${escaparHtml(t.etiqueta)}</b> · ` : ""}<code>${t.codigo}</code></span>
                  <form method="POST" action="/editar/${slug}/desvincular/${t.codigo}?key=${key}" style="margin:0;" onsubmit="return confirm('¿Desvincular la tarjeta ${t.codigo}? Deja de sumar datos a ${escaparHtml(valores.nombre || "este negocio")} y vuelve a quedar sin activar — se puede activar de nuevo después, como negocio nuevo o vinculada a otro.');">
                    <button type="submit" style="margin:0;background:#fff;color:${MARCA.rojo};border:1px solid #F0D0C8;padding:6px 12px;font-size:0.78rem;border-radius:7px;">Desvincular</button>
                  </form>
                </div>
              `).join("")
              : `<p style="color:${MARCA.textoSuave};font-size:0.82rem;margin:0;">Todavía no tiene tarjetas adicionales vinculadas.</p>`}
          </div>
          ` : ""}
        </div>
      </body>
    </html>
  `;
}


// Panel de generación y administración de códigos de activación.
// Genera un código por cada tarjeta física ANTES de saber a qué negocio va.
// Visítalo así: https://tu-dominio.com/codigos?key=TU_CLAVE
app.get("/codigos", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }

  const codigos = leerCodigos();
  const key = req.query.key;

  const filas = Object.entries(codigos)
    .sort((a, b) => new Date(b[1].creado) - new Date(a[1].creado))
    .map(([codigo, info]) => {
      const estado = info.activado
        ? `<span class="pill pill-on">Activado — ${info.negocio.nombre}</span>`
        : `<span class="pill pill-off">Sin activar</span>`;
      const accion = info.activado
        ? `<a href="/stats?key=${key}">Ver en el panel</a>`
        : `<a href="/activar/${codigo}" target="_blank">Activar ahora</a>`;
      const urlTarjeta = `${req.protocol}://${req.get("host")}/r/${codigo}`;
      const factura = info.datosFactura && (info.datosFactura.razonSocial || info.datosFactura.nit)
        ? `${escaparHtml(info.datosFactura.razonSocial || "—")}${info.datosFactura.nit ? ` (NIT ${escaparHtml(info.datosFactura.nit)})` : ""}`
        : "—";
      return `<tr>
        <td><code class="codigo">${codigo}</code></td>
        <td>${estado}</td>
        <td class="url-cell">${urlTarjeta}</td>
        <td style="font-size:0.8rem;">${factura}</td>
        <td>${accion}</td>
      </tr>`;
    })
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Códigos de activación — Tapin</title>
        <style>
          ${ESTILO_BASE}
          .panel-generar{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;padding:22px 24px;margin-bottom:28px;max-width:480px;}
          .panel-generar label{font-size:0.82rem;font-weight:600;color:${MARCA.textoSuave};display:block;margin-bottom:6px;}
          .panel-generar input{width:90px;padding:9px 12px;border:1px solid ${MARCA.borde};border-radius:8px;font-size:0.92rem;margin-right:10px;}
          .panel-generar button{background:${MARCA.verdeOscuro};color:#fff;border:none;border-radius:8px;padding:10px 18px;font-weight:600;font-size:0.88rem;cursor:pointer;}
          .panel-generar button:hover{background:${MARCA.verde};}
          table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid ${MARCA.borde};}
          th,td{padding:12px 16px;text-align:left;font-size:0.86rem;border-bottom:1px solid ${MARCA.borde};}
          th{background:${MARCA.verdeOscuro};color:#fff;font-size:0.74rem;text-transform:uppercase;letter-spacing:0.04em;}
          .codigo{background:${MARCA.verdeClaro};padding:4px 10px;border-radius:6px;font-weight:700;letter-spacing:0.05em;}
          .pill{font-size:0.72rem;font-weight:700;padding:4px 10px;border-radius:100px;}
          .pill-on{background:${MARCA.verdeClaro};color:${MARCA.verdeOscuro};}
          .pill-off{background:#FBEFE9;color:${MARCA.rojo};}
          .url-cell{font-family:monospace;font-size:0.78rem;color:${MARCA.textoSuave};}
          a{font-weight:600;text-decoration:none;}
        </style>
      </head>
      <body>
        <div class="topbar">
          <div>${logoSvg("#FFFFFF", 30)}</div>
          <a class="back" href="/stats?key=${key}">&larr; Volver al panel</a>
        </div>
        <div class="content">
          <div class="eyebrow">Aprovisionamiento</div>
          <h1 class="titulo-pagina">Códigos de activación</h1>
          <div class="subtitulo">Genera un código por cada tarjeta física antes de tener el cliente, prográmala con esa URL, y actívala después con los datos reales.</div>

          <div class="panel-generar">
            <form method="POST" action="/codigos/generar?key=${key}">
              <label>¿Cuántos códigos nuevos quieres generar?</label>
              <input type="number" name="cantidad" value="10" min="1" max="200">
              <button type="submit">Generar códigos</button>
              <div style="margin-top:16px;padding-top:16px;border-top:1px solid ${MARCA.borde};">
                <label>Correo del negocio (opcional — si lo pones, le mandamos los códigos nuevos por correo)</label>
                <input type="email" name="email" placeholder="dueno@negocio.com" style="width:100%;box-sizing:border-box;">
              </div>
              <div style="margin-top:16px;padding-top:16px;border-top:1px solid ${MARCA.borde};">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                  <input type="checkbox" name="proIncluido" value="si" id="check-admin-pro" style="width:auto;"
                         onchange="document.getElementById('admin-plan-pro-tipo').style.display=this.checked?'block':'none';">
                  Marcar como Plan Pro incluido (cortesía, sin cobro)
                </label>
                <div id="admin-plan-pro-tipo" style="display:none;margin-top:10px;">
                  <label style="display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer;">
                    <input type="radio" name="planProTipo" value="mensual" checked style="width:auto;"> Mensual
                  </label>
                  <label style="display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer;">
                    <input type="radio" name="planProTipo" value="anual" style="width:auto;"> Anual (1 año desde la activación)
                  </label>
                </div>
              </div>
            </form>
          </div>

          <table>
            <tr><th>Código</th><th>Estado</th><th>URL para la tarjeta NFC</th><th>Factura</th><th></th></tr>
            ${filas || "<tr><td colspan='4'>Todavía no has generado ningún código.</td></tr>"}
          </table>
        </div>
      </body>
    </html>
  `);
});

// Genera N códigos nuevos y los guarda. Si viene un correo, se los manda de una
// vez — un código en el correo si generaste 1, o todos los que hayan sido
// necesarios si generaste varios (ej: un negocio con varias sedes).
app.post("/codigos/generar", limitarIntentosAdmin, async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const cantidad = Math.min(200, Math.max(1, parseInt(req.body.cantidad, 10) || 1));
  const email = (req.body.email || "").trim().toLowerCase();
  const proIncluido = req.body.proIncluido === "si";
  const planProTipo = req.body.planProTipo === "anual" ? "anual" : "mensual";
  const codigos = leerCodigos();
  const nuevos = [];

  for (let i = 0; i < cantidad; i++) {
    let nuevo;
    do {
      nuevo = generarCodigo();
    } while (codigos[nuevo]); // evita colisiones, aunque son muy improbables
    codigos[nuevo] = {
      activado: false,
      creado: new Date().toISOString(),
      proIncluido,
      planProTipo: proIncluido ? planProTipo : null,
    };
    nuevos.push(nuevo);
  }

  guardarCodigos(codigos);
  registrarAuditoriaGlobal("generar_codigos", `${cantidad} código(s) generado(s)${proIncluido ? ` con Plan Pro ${planProTipo} incluido` : ""}${email ? ` — enviados a ${email}` : ""}`, req);

  if (email && nuevos.length > 0) {
    const base = `${req.protocol}://${req.get("host")}`;
    const filas = nuevos
      .map((c) => `<li style="margin-bottom:8px;">
          <b style="letter-spacing:0.05em;">${c}</b> —
          <a href="${base}/activar/${c}">Activar esta tarjeta</a>
        </li>`)
      .join("");
    await enviarEmail(
      email,
      nuevos.length === 1 ? "Tu código de activación Tapin" : `Tus ${nuevos.length} códigos de activación Tapin`,
      `<div style="font-family:-apple-system,Arial,sans-serif;max-width:460px;">
         <h2 style="color:${MARCA.verdeOscuro};">¡Ya casi! Activa tu${nuevos.length > 1 ? "s" : ""} tarjeta${nuevos.length > 1 ? "s" : ""} Tapin</h2>
         <p>Toca el enlace de cada tarjeta para configurarla con los datos de tu negocio (una por cada local, si tienes varios).</p>
         <ul style="padding-left:18px;">${filas}</ul>
         <p style="font-size:0.8rem;color:#888;">Si ya activaste una tarjeta antes, usa el mismo correo al activar las demás para verlas todas juntas en <a href="${base}/mis-negocios">tu panel</a>.</p>
       </div>`
    ).catch((err) => console.error("[codigos] Error enviando correo:", err.message));
  }

  res.redirect(`/codigos?key=${req.query.key}`);
});

// Formulario para activar una tarjeta: el negocio (o tú, en su nombre) llena sus datos reales.
// Visítalo así: https://tu-dominio.com/activar/7K9P2M
app.get("/activar/:codigo", (req, res) => {
  const { codigo } = req.params;
  const codigos = leerCodigos();
  const entrada = codigos[codigo];

  if (!entrada) {
    return res.status(404).send("Código no válido. Verifica que lo escribiste bien.");
  }
  if (entrada.activado) {
    const negocioDeEstaTarjeta = obtenerNegocio(codigo);
    return res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h2>Esta tarjeta ya está activada</h2>
        <p>Pertenece a: <b>${negocioDeEstaTarjeta ? negocioDeEstaTarjeta.nombre : "(negocio no encontrado)"}</b></p>
        ${entrada.vinculadoA ? `<p style="color:#888;font-size:0.85rem;">Es una tarjeta adicional vinculada a ese negocio.</p>` : ""}
      </body></html>
    `);
  }

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Configurar tarjeta — Tapin</title>
        <style>
          ${ESTILO_BASE}
          .form-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:16px;padding:28px;max-width:480px;
                     box-shadow:0 8px 24px rgba(11,61,44,0.06);}
          label{font-size:0.82rem;font-weight:600;color:${MARCA.textoSuave};display:block;margin:14px 0 6px;}
          label:first-of-type{margin-top:0;}
          input,select{width:100%;padding:11px 13px;border:1px solid ${MARCA.borde};border-radius:9px;font-size:0.92rem;font-family:inherit;}
          button{margin-top:22px;width:100%;background:${MARCA.verdeOscuro};color:#fff;border:none;border-radius:9px;
                 padding:13px;font-size:0.95rem;font-weight:700;cursor:pointer;}
          button:hover{background:${MARCA.verde};}

          .direccion-wrap{position:relative;}
          .sugerencias{position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid ${MARCA.borde};
                       border-top:none;border-radius:0 0 9px 9px;max-height:220px;overflow-y:auto;z-index:20;
                       box-shadow:0 8px 20px rgba(0,0,0,0.08);display:none;}
          .sugerencias.activo{display:block;}
          .sugerencia-item{padding:10px 13px;font-size:0.85rem;cursor:pointer;border-bottom:1px solid ${MARCA.crema};}
          .sugerencia-item:last-child{border-bottom:none;}
          .sugerencia-item:hover, .sugerencia-item.resaltada{background:${MARCA.verdeClaro};}
          .direccion-estado{font-size:0.74rem;color:${MARCA.textoSuave};margin-top:4px;min-height:14px;}
          .direccion-ok{color:${MARCA.verde};font-weight:600;}

          .categorias{display:flex;flex-wrap:wrap;gap:8px;}
          .cat-chip{border:1.5px solid ${MARCA.borde};border-radius:100px;padding:9px 16px;font-size:0.84rem;
                    font-weight:600;color:${MARCA.textoSuave};cursor:pointer;background:#fff;transition:all 0.12s;}
          .cat-chip.activo{background:${MARCA.verde};border-color:${MARCA.verde};color:#fff;}

          .modo-toggle{display:flex;gap:8px;margin-bottom:20px;background:${MARCA.crema};border-radius:11px;padding:4px;}
          .modo-btn{flex:1;text-align:center;padding:10px 10px;border-radius:8px;font-size:0.82rem;font-weight:700;
                    color:${MARCA.textoSuave};cursor:pointer;transition:all 0.12s;}
          .modo-btn.activo{background:#fff;color:${MARCA.verdeOscuro};box-shadow:0 2px 6px rgba(11,61,44,0.1);}
        </style>
      </head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div></div>
        <div class="content">
          <div class="eyebrow">Código ${codigo}</div>
          <h1 class="titulo-pagina">Configura tu tarjeta Tapin</h1>
          <div class="subtitulo">Completa los datos del negocio para dejar la tarjeta lista para usar.</div>

          <div class="form-card">
            <form method="POST" action="/activar/${codigo}" id="form-activar">
              <div class="modo-toggle">
                <div class="modo-btn activo" data-modo="nuevo">Es un negocio nuevo</div>
                <div class="modo-btn" data-modo="vincular">Ya tengo un negocio en Tapin</div>
              </div>
              <input type="hidden" name="modo" id="input-modo" value="nuevo">

              <div id="bloque-vincular" style="display:none;">
                <p class="nota" style="margin:0 0 16px;font-size:0.82rem;color:${MARCA.textoSuave};line-height:1.5;">
                  Úsalo si este local ya tiene otra tarjeta Tapin activa — por ejemplo, una tarjeta por mesa, o una
                  en la caja y otra en la entrada. Esta tarjeta se suma a las estadísticas del mismo negocio, no
                  crea uno aparte.
                </p>
                <label>Identificador del negocio ya activo</label>
                <input type="text" name="slugExistente" id="input-slug-existente"
                       placeholder="Lo encuentras en tu panel → Configuración → Tarjetas vinculadas">

                <label>Clave de acceso de ese negocio</label>
                <input type="text" name="claveExistente" id="input-clave-existente"
                       placeholder="La misma clave con la que entras a su panel">
              </div>

              <div id="bloque-nuevo">
              ${process.env.GOOGLE_PLACES_API_KEY ? `
              <label>Busca tu negocio en Google (opcional — te llena los datos solo)</label>
              <input type="text" id="buscador-places" placeholder="Escribe el nombre de tu negocio..."
                     style="margin-bottom:6px;">
              <p class="nota" style="margin:-4px 0 16px;font-size:0.76rem;color:${MARCA.textoSuave};">
                Si tu negocio no aparece en la búsqueda, no hay problema — llena los campos de abajo a mano.
              </p>
              ` : ""}

              <label>Nombre del negocio</label>
              <input type="text" name="nombre" id="input-nombre" required placeholder="Ej: Restaurante La 21">

              <label>Enlace de reseñas de Google</label>
              <input type="url" name="googleUrl" id="input-google-url" required placeholder="https://g.page/r/.../review">
              <div style="background:${MARCA.crema};border-radius:9px;padding:12px 14px;margin-top:8px;font-size:0.78rem;color:${MARCA.textoSuave};line-height:1.6;">
                <b style="color:${MARCA.texto};">¿De dónde saco este enlace?</b><br>
                1. Busca el nombre de tu negocio en Google, entrando con el Gmail que lo administra.<br>
                2. En el panel de dueño que te aparece, toca el botón <b>"Pedir reseñas"</b>.<br>
                3. Copia el enlace que te da Google (empieza por <b>g.page/r/...</b>) y pégalo aquí.<br>
                <span style="color:${MARCA.rojo};font-weight:600;">Ojo: no sirve el enlace de "Compartir" de Google Maps (el que empieza por maps.app.goo.gl) — ese solo muestra tu negocio en el mapa, no abre el formulario de reseña. Tiene que ser el enlace de <b>"Pedir reseñas"</b>.</span>
              </div>

              <label>Email del negocio (alertas y reportes llegan aquí)</label>
              <input type="email" name="email" required placeholder="dueno@negocio.com">

              <label>Crea la clave de acceso a tu panel</label>
              <input type="text" name="claveAcceso" required minlength="6"
                     placeholder="Mínimo 6 caracteres — la vas a necesitar para entrar a tu panel">

              <label>Departamento</label>
              <select name="departamento" id="sel-departamento" required>
                <option value="">Selecciona un departamento...</option>
              </select>

              <label>Ciudad</label>
              <input type="text" name="ciudad" id="input-ciudad" list="lista-ciudades" required
                     placeholder="Primero elige el departamento" autocomplete="off" disabled>
              <datalist id="lista-ciudades"></datalist>

              <label>Dirección exacta</label>
              <input type="text" name="direccion" id="input-direccion" required placeholder="Ej: Cra 7 # 12-34, local 2">

              <label>Categoría</label>
              <div class="categorias" id="categorias">
                <div class="cat-chip activo" data-valor="restaurante">Restaurante</div>
                <div class="cat-chip" data-valor="peluqueria">Peluquería / Barbería</div>
                <div class="cat-chip" data-valor="tienda">Tienda</div>
                <div class="cat-chip" data-valor="clinica">Clínica / Consultorio</div>
                <div class="cat-chip" data-valor="otro">Otro</div>
              </div>
              <input type="hidden" name="categoria" id="input-categoria" value="restaurante">

              <label>Plan</label>
              ${entrada.proIncluido
                ? `<div style="background:${MARCA.verdeClaro};color:${MARCA.verdeOscuro};padding:12px 14px;border-radius:9px;font-size:0.88rem;font-weight:600;">
                     ✓ Plan Pro ${entrada.planProTipo === "anual" ? "anual" : "mensual"} — ya incluido con la compra de esta tarjeta
                   </div>`
                : `<div style="background:${MARCA.crema};color:${MARCA.textoSuave};padding:12px 14px;border-radius:9px;font-size:0.88rem;">
                     Plan Básico ($119.900 — pago único). ¿Quieres Pro? Lo puedes agregar después desde tu panel.
                   </div>`}

              <label>País (define la hora local de los reportes)</label>
              <select name="pais" id="input-pais">
                <option value="colombia" data-codigo="co">Colombia</option>
                <option value="panama" data-codigo="pa">Panamá</option>
                <option value="paraguay" data-codigo="py">Paraguay</option>
                <option value="miami" data-codigo="us">Estados Unidos (Miami)</option>
              </select>

              </div>

              <button type="submit">Activar tarjeta</button>
            </form>          </div>
        </div>

        <script>
          // ---------- Selección de categoría por chips ----------
          document.querySelectorAll('.cat-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
              document.querySelectorAll('.cat-chip').forEach((c) => c.classList.remove('activo'));
              chip.classList.add('activo');
              document.getElementById('input-categoria').value = chip.dataset.valor;
            });
          });

          // ---------- Departamento y ciudad (igual que en /pedido) ----------
          const COLOMBIA_CIUDADES = ${JSON.stringify(COLOMBIA_CIUDADES)};
          const selDepto = document.getElementById('sel-departamento');
          const inputCiudadActivar = document.getElementById('input-ciudad');
          const listaCiudadesActivar = document.getElementById('lista-ciudades');

          Object.keys(COLOMBIA_CIUDADES).forEach((depto) => {
            const opt = document.createElement('option');
            opt.value = depto;
            opt.textContent = depto;
            selDepto.appendChild(opt);
          });

          selDepto.addEventListener('change', () => {
            listaCiudadesActivar.innerHTML = '';
            inputCiudadActivar.value = '';
            const ciudades = COLOMBIA_CIUDADES[selDepto.value] || [];
            if (ciudades.length) {
              inputCiudadActivar.disabled = false;
              inputCiudadActivar.placeholder = 'Escribe para buscar tu ciudad...';
              ciudades.forEach((c) => {
                const opt = document.createElement('option');
                opt.value = c;
                listaCiudadesActivar.appendChild(opt);
              });
            } else {
              inputCiudadActivar.disabled = true;
              inputCiudadActivar.placeholder = 'Primero elige el departamento';
            }
          });

          // ---------- Selector "negocio nuevo" vs. "vincular a uno existente" ----------
          const bloqueNuevo = document.getElementById('bloque-nuevo');
          const bloqueVincular = document.getElementById('bloque-vincular');
          const inputModo = document.getElementById('input-modo');
          const camposSoloNuevo = bloqueNuevo.querySelectorAll('[required]');
          const camposSoloVincular = bloqueVincular.querySelectorAll('input');

          document.querySelectorAll('.modo-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
              document.querySelectorAll('.modo-btn').forEach((b) => b.classList.remove('activo'));
              btn.classList.add('activo');
              const modo = btn.dataset.modo;
              inputModo.value = modo;
              const esVincular = modo === 'vincular';
              bloqueNuevo.style.display = esVincular ? 'none' : '';
              bloqueVincular.style.display = esVincular ? '' : 'none';
              camposSoloNuevo.forEach((c) => { c.required = !esVincular; });
              camposSoloVincular.forEach((c) => { c.required = esVincular; });
            });
          });
        </script>
        ${process.env.GOOGLE_PLACES_API_KEY ? `
        <script>
          function iniciarPlaces() {
            const buscador = document.getElementById('buscador-places');
            if (!buscador || !window.google) return;
            const autocomplete = new google.maps.places.Autocomplete(buscador, {
              fields: ['place_id', 'name', 'formatted_address'],
            });
            autocomplete.addListener('place_changed', () => {
              const lugar = autocomplete.getPlace();
              if (!lugar.place_id) return;
              if (lugar.name) document.getElementById('input-nombre').value = lugar.name;
              if (lugar.formatted_address) document.getElementById('input-direccion').value = lugar.formatted_address;
              document.getElementById('input-google-url').value =
                'https://search.google.com/local/writereview?placeid=' + lugar.place_id;
            });
          }
        </script>
        <script async src="https://maps.googleapis.com/maps/api/js?key=${process.env.GOOGLE_PLACES_API_KEY}&libraries=places&callback=iniciarPlaces"></script>
        ` : ""}
      </body>
    </html>
  `);
});

// Procesa la activación: guarda los datos del negocio y marca el código como usado.
app.post("/activar/:codigo", (req, res) => {
  const { codigo } = req.params;
  const codigos = leerCodigos();
  const entrada = codigos[codigo];

  if (!entrada) return res.status(404).send("Código no válido.");
  if (entrada.activado) return res.status(400).send("Esta tarjeta ya fue activada antes.");

  const modo = req.body.modo === "vincular" ? "vincular" : "nuevo";

  // Modo "vincular": esta tarjeta NO crea un negocio nuevo — se conecta a uno
  // que ya existe (varias tarjetas físicas para un mismo local). Se exige la
  // clave de acceso del negocio destino para comprobar que quien activa esta
  // tarjeta de verdad es dueño de ese negocio, y no solo adivinó su identificador.
  if (modo === "vincular") {
    const slugInput = (req.body.slugExistente || "").trim();
    const claveInput = (req.body.claveExistente || "").trim();
    if (!slugInput || !claveInput) {
      return res.status(400).send("Falta el identificador del negocio existente o su clave de acceso.");
    }
    const slugPrincipal = resolverSlug(slugInput, codigos);
    if (slugPrincipal === codigo) {
      return res.status(400).send("No puedes vincular una tarjeta consigo misma.");
    }
    const negocioExistente = obtenerNegocio(slugPrincipal);
    if (!negocioExistente) {
      return res.status(404).send("No encontramos ningún negocio activo con ese identificador. Verifica que lo hayas copiado bien.");
    }
    if (!tieneClaveConfigurada(negocioExistente) || !claveNegocioValida(negocioExistente, slugPrincipal, claveInput)) {
      return res.status(401).send("La clave no coincide con la de ese negocio. Verifícala e inténtalo de nuevo.");
    }
    entrada.activado = true;
    entrada.activadoEl = new Date().toISOString();
    entrada.vinculadoA = slugPrincipal;
    delete entrada.negocio;
    guardarCodigos(codigos);
    registrarAuditoriaGlobal(
      "vincular_tarjeta",
      `Tarjeta ${codigo} vinculada al negocio "${negocioExistente.nombre}" (${slugPrincipal}) — tarjeta adicional del mismo local`,
      req
    );

    return res.send(`
      <html>
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>${ESTILO_BASE}
          .ok-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:16px;padding:28px;max-width:460px;}
          .ok-card code{background:${MARCA.verdeClaro};padding:3px 8px;border-radius:6px;font-size:0.82rem;}
        </style></head>
        <body>
          <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div></div>
          <div class="content">
            <div class="eyebrow">Listo</div>
            <h1 class="titulo-pagina">¡Tarjeta vinculada!</h1>
            <div class="ok-card">
              <p>Esta tarjeta ya está conectada a <b>${escaparHtml(negocioExistente.nombre)}</b> — todo lo que pase en ella
                 (toques, calificaciones, quejas, sellos de fidelización) se suma a las estadísticas de ese mismo negocio,
                 no crea uno aparte.</p>
              <p>Panel de este negocio:<br><code>${req.protocol}://${req.get("host")}/mi-panel/${slugPrincipal}?key=${encodeURIComponent(claveInput)}</code></p>
              <p>La tarjeta ya está lista — el cliente puede empezar a usarla de inmediato.</p>
            </div>
          </div>
        </body>
      </html>
    `);
  }

  const { nombre, googleUrl, categoria, pais, email, plan, direccion, departamento, ciudad, claveAcceso } = req.body;
  if (!nombre || !googleUrl) {
    return res.status(400).send("Faltan datos: nombre y enlace de Google son obligatorios.");
  }
  if (!esLinkGoogleValido(googleUrl)) {
    return res.status(400).send(
      "Ese enlace no sirve para reseñas — debe ser el link de \"Pedir reseñas\" de Google (empieza por " +
      "https://g.page/r/.../review), NO el enlace de \"Compartir\" de Google Maps (ese solo muestra el " +
      "negocio en el mapa). Para sacarlo: busca el nombre de tu negocio en Google con el Gmail que lo " +
      "administra, y en el panel de dueño toca el botón \"Pedir reseñas\". Copia ese enlace, regresa e " +
      "inténtalo de nuevo."
    );
  }
  const claveLimpia = (claveAcceso || "").trim();
  if (claveLimpia.length < 6) {
    return res.status(400).send("La clave de acceso debe tener al menos 6 caracteres. Regresa e inténtalo de nuevo.");
  }
  entrada.activado = true;
  entrada.activadoEl = new Date().toISOString();
  // El plan Pro NO se decide por lo que venga en el formulario (eso se
  // podría manipular) — se decide por lo que la tarjeta tenga guardado desde
  // que se pagó el pedido. Si no vino de un pedido con Pro, siempre básico.
  const planReal = entrada.proIncluido ? "pro" : "basico";
  const { salt: saltActivacion, hash: hashActivacion } = hashClaveNegocio(claveLimpia);
  entrada.negocio = {
    nombre,
    googleUrl,
    categoria: categoria || "otro",
    pais: pais || "colombia",
    claveAccesoHash: hashActivacion,
    claveAccesoSalt: saltActivacion,
    email: email || "",
    plan: planReal,
    direccion: direccion || "",
    departamento: departamento || "",
    ciudad: ciudad || "",
    // Se copia del pedido original (si el comprador dejo NIT al pagar la
    // tarjeta) para poder seguir facturando electronicamente las
    // mejoras a Pro y las renovaciones mensuales sin volver a pedirlo.
    // Editable luego desde Configuracion del panel del negocio.
    datosFactura: entrada.datosFactura || null,
  };
  if (planReal === "pro" && entrada.planProTipo === "anual") {
    const unAnioDespues = new Date();
    unAnioDespues.setFullYear(unAnioDespues.getFullYear() + 1);
    entrada.negocio.billingType = "anual";
    entrada.negocio.proAnualHasta = unAnioDespues.toISOString();
  } else if (planReal === "pro") {
    entrada.negocio.billingType = "mensual";
  }

  guardarCodigos(codigos);

  // Si el pedido incluía Plan Pro mensual y quedó marcado "renovar
  // automáticamente", el paso que sigue de inmediato es registrar la
  // tarjeta — sin eso, el Pro no se renueva después del primer mes y nadie
  // se entera hasta que deje de funcionar. Se lo mostramos ANTES que el
  // acceso normal al panel, como el siguiente paso obvio, no como algo
  // opcional escondido en configuración.
  if (planReal === "pro" && entrada.planProTipo === "mensual" && entrada.renovarAutomatico) {
    return res.send(`
      <html>
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>${ESTILO_BASE}
          .ok-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:16px;padding:28px;max-width:460px;}
          .ok-card code{background:${MARCA.verdeClaro};padding:3px 8px;border-radius:6px;font-size:0.82rem;}
        </style></head>
        <body>
          <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div></div>
          <div class="content">
            <div class="eyebrow">Un paso más</div>
            <h1 class="titulo-pagina">¡Tarjeta activada! Ahora registra tu tarjeta</h1>
            <div class="ok-card">
              <p><b>${nombre}</b> ya está conectado a esta tarjeta Tapin, con Plan Pro activo desde ya.</p>
              <p>Para que el Plan Pro se siga renovando solo cada mes, falta registrar una tarjeta de cobro — es lo único que queda pendiente.</p>
              <a class="btn-primario" href="/suscripcion/${codigo}?key=${encodeURIComponent(claveLimpia)}" style="display:inline-block;margin-top:6px;">Registrar tarjeta para el cobro mensual</a>
              <p style="margin-top:16px;font-size:0.78rem;">También puedes hacerlo después desde tu panel:<br><code>${req.protocol}://${req.get("host")}/mi-panel/${codigo}?key=${encodeURIComponent(claveLimpia)}</code></p>
            </div>
          </div>
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${ESTILO_BASE}
        .ok-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:16px;padding:28px;max-width:460px;}
        .ok-card code{background:${MARCA.verdeClaro};padding:3px 8px;border-radius:6px;}
      </style></head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div></div>
        <div class="content">
          <div class="eyebrow">Listo</div>
          <h1 class="titulo-pagina">¡Tarjeta activada!</h1>
          <div class="ok-card">
            <p><b>${nombre}</b> ya está conectado a esta tarjeta Tapin.</p>
            <p>Panel de este negocio:<br><code>${req.protocol}://${req.get("host")}/mi-panel/${codigo}?key=${encodeURIComponent(claveLimpia)}</code></p>
            <p>Esta tarjeta ya está lista — el cliente puede empezar a usarla de inmediato.</p>
          </div>
        </div>
      </body>
    </html>
  `);
});

app.get("/stats", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    if (req.query.key) {
      return enviarError(res, 401, "Clave incorrecta", "La clave que ingresaste no es válida. Verifícala e inténtalo de nuevo.", { texto: "Volver a intentar", href: "/stats" });
    }
    return res.status(401).send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acceso administrador — Tapin</title>
  <style>${ESTILO_BASE}
    body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;}
    .caja-login{background:#fff;border-radius:20px;padding:40px 38px;max-width:380px;width:100%;text-align:center;
                box-shadow:0 20px 50px rgba(9,49,30,.1);border:1px solid ${MARCA.borde};box-sizing:border-box;}
    .caja-login h1{font-size:1.25rem;margin:16px 0 6px;letter-spacing:-.02em;}
    .caja-login p{color:${MARCA.textoSuave};font-size:0.86rem;line-height:1.5;margin:0 0 24px;}
    .caja-login label{display:block;text-align:left;font-size:0.78rem;font-weight:600;color:${MARCA.texto};margin-bottom:6px;}
    .caja-login input{width:100%;box-sizing:border-box;padding:12px 14px;border:1.5px solid ${MARCA.borde};border-radius:9px;
                       font-size:0.92rem;font-family:inherit;margin-bottom:16px;}
    .caja-login button{width:100%;}
  </style>
</head>
<body>
  <div class="caja-login">
    ${logoSvg(MARCA.verdeOscuro, 28)}
    <h1>Acceso de administrador</h1>
    <p>Ingresa tu clave para entrar al panel de administración de Tapin.</p>
    <form method="GET" action="/stats">
      <label for="key">Clave de administrador</label>
      <input type="password" id="key" name="key" autofocus required autocomplete="current-password">
      <button type="submit" class="btn-primario">Entrar</button>
    </form>
  </div>
</body>
</html>`);
  }
  iniciarSesionAdmin(res);

  const datos = leerDatos();
  const key = req.query.key;
  const NEGOCIOS_TOTAL = todosLosNegocios();

  // Totales agregados de TODAS las tarjetas juntas (sección de resumen general)
  let totalNegocios = 0;
  let totalToquesGlobal = 0;
  let totalHoyGlobal = 0;
  let totalSemanaGlobal = 0;
  const estrellasGlobales = [];
  const dias7Global = new Array(7).fill(0);
  for (const slug in NEGOCIOS_TOTAL) {
    const eventos = (datos[slug] && datos[slug].eventos) || [];
    const testimonios = (datos[slug] && datos[slug].testimonios) || [];
    const quejas = (datos[slug] && datos[slug].quejas) || [];
    testimonios.forEach((t) => estrellasGlobales.push(t));
    quejas.forEach((q) => estrellasGlobales.push(q));
    const r = calcularResumen(eventos);
    totalNegocios++;
    totalToquesGlobal += r.total;
    totalHoyGlobal += r.hoy;
    totalSemanaGlobal += r.semana;
    r.dias7.forEach((v, i) => { dias7Global[i] += v; });
  }
  const promedioEstrellas = promedioEstrellasFiltradas(estrellasGlobales);
  const testimonios = estrellasGlobales;

  const PAISES_INFO = {
    colombia: { nombre: "Colombia", bandera: "🇨🇴" },
    panama: { nombre: "Panamá", bandera: "🇵🇦" },
    paraguay: { nombre: "Paraguay", bandera: "🇵🇾" },
    miami: { nombre: "Estados Unidos (Miami)", bandera: "🇺🇸" },
  };

  // Agrupamos los negocios por país antes de armar el HTML.
  const negociosPorPais = {};
  for (const slug in NEGOCIOS_TOTAL) {
    const paisSlug = NEGOCIOS_TOTAL[slug].pais || "colombia";
    if (!negociosPorPais[paisSlug]) negociosPorPais[paisSlug] = [];
    negociosPorPais[paisSlug].push(slug);
  }

  const mesActual = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

  function tarjetaHtml(slug) {
    const eventos = (datos[slug] && datos[slug].eventos) || [];
    const testimonios = (datos[slug] && datos[slug].testimonios) || [];
    const quejas = (datos[slug] && datos[slug].quejas) || [];
    const promedioEstrellasNegocio = promedioEstrellasFiltradas(testimonios, quejas);
    const r = calcularResumen(eventos);
    const ultimoTexto = r.ultimo ? r.ultimo.fechaLegible : "Sin toques todavía";
    const promSector = promedioSector(NEGOCIOS_TOTAL[slug].categoria, slug, datos);
    const sectorBadge = promSector !== null
      ? `<div class="sector-badge" style="color:${r.semana - promSector >= 0 ? MARCA.verde : MARCA.rojo}">
           ${r.semana - promSector >= 0 ? "▲" : "▼"} ${r.semana - promSector >= 0 ? "+" : ""}${r.semana - promSector} vs. promedio del sector
         </div>`
      : "";

    // Indicador de reporte mensual — solo aplica a negocios Pro.
    let reporteBadge = "";
    if (esPro(NEGOCIOS_TOTAL[slug])) {
      const reportes = (datos[slug] && datos[slug].reportesEnviados) || [];
      const yaEnviado = reportes.some((rp) => rp.mes === mesActual && rp.exitoso);
      const ultimoFallido = !yaEnviado && reportes.length > 0 ? reportes[reportes.length - 1] : null;
      reporteBadge = yaEnviado
        ? `<div class="reporte-badge ok">✅ Reporte de este mes enviado</div>`
        : ultimoFallido && ultimoFallido.mes === mesActual
          ? `<div class="reporte-badge fail">⚠️ Falló el envío este mes (${ultimoFallido.motivo || "error"})</div>`
          : `<div class="reporte-badge pendiente">— Reporte de este mes aún no enviado</div>`;
    }

    // El administrador ya fue autenticado en /stats. Como las claves de los
    // negocios ahora se guardan cifradas, no se imprime negocio.claveAcceso.
    // Se crea un token temporal limitado exclusivamente a este negocio para
    // abrir su panel sin pedir otra clave ni exponer la clave real.
    const tokenPanelAdmin = tieneClaveConfigurada(NEGOCIOS_TOTAL[slug])
      ? generarLinkAccesoNegocio(slug, 1, true)
      : null;

    return `
      <div class="card">
        <div class="card-top">
          <div>
            <div class="card-nombre">${NEGOCIOS_TOTAL[slug].nombre} ${esPro(NEGOCIOS_TOTAL[slug]) ? `<span class="badge-pro">PRO</span>` : `<span class="badge-basico">BÁSICO</span>`}</div>
            <div class="card-slug">/r/${slug}</div>
          </div>
          <div class="card-total">${r.total}<span>toques totales</span></div>
        </div>

        <div class="card-metrics">
          <div class="metric"><div class="metric-num">${r.hoy}</div><div class="metric-lbl">Hoy</div></div>
          <div class="metric"><div class="metric-num">${r.semana}</div><div class="metric-lbl">Últimos 7 días</div></div>
        </div>

        <div class="sparkline">${barraSemana(r.dias7)}</div>
        ${sectorBadge}
        ${reporteBadge}

        <div class="card-ultimo">Último toque: <b>${ultimoTexto}</b></div>

        <div class="card-ultimo" style="margin-bottom:12px;padding-top:10px;">Promedio filtrado: <b style="color:${MARCA.oro};">${promedioEstrellasNegocio !== null ? promedioEstrellasNegocio + " / 5 ★" : "Sin calificaciones"}</b></div>

        <div class="card-actions">
          <a href="/historial/${slug}?key=${key}">Historial</a>
          <a href="/reporte/${slug}?key=${key}">Reporte</a>
          ${tokenPanelAdmin ? `<a class="btn-panel-negocio" href="/mi-panel/${slug}?key=${encodeURIComponent(tokenPanelAdmin)}" target="_blank">Abrir panel del negocio ↗</a>` : `<span class="sin-panel">Sin panel activado</span>`}
          <a href="/export/${slug}.csv?key=${key}">CSV</a>
          <a href="/export/${slug}.pdf?key=${key}">PDF</a>
          <a href="/export/${slug}.docx?key=${key}">Word</a>
          <a href="/entrega/${slug}.pdf?key=${key}">Acta de entrega</a>
          <a href="/quejas/${slug}?key=${key}">Retroalimentación</a>
          <a href="/notificar/${slug}?key=${key}">Enviar reporte por email</a>
          <a href="/reportes-guardados/${slug}?key=${key}">Reportes guardados</a>
        </div>
      </div>`;
  }

  // Una sección completa por país, solo para los que tengan al menos un negocio.
  let seccionesPaises = "";
  for (const codigoPais of Object.keys(PAISES_INFO)) {
    const slugs = negociosPorPais[codigoPais];
    if (!slugs || slugs.length === 0) continue;

    const totalPais = slugs.reduce((acc, slug) => {
      const eventos = (datos[slug] && datos[slug].eventos) || [];
      return acc + calcularResumen(eventos).total;
    }, 0);

    seccionesPaises += `
      <div class="seccion-pais" id="pais-${codigoPais}">
        <div class="pais-header">
          <div class="pais-titulo">${PAISES_INFO[codigoPais].bandera} ${PAISES_INFO[codigoPais].nombre}</div>
          <div class="pais-conteo">${slugs.length} ${slugs.length === 1 ? "negocio" : "negocios"} · ${totalPais} toques totales</div>
        </div>
        <div class="lista-negocios">
          ${slugs.map(tarjetaHtml).join("")}
        </div>
      </div>`;
  }

  // Botones de acceso rápido arriba: uno por cada país que tenga negocios, saltan directo a su sección.
  let botonesPaises = "";
  for (const codigoPais of Object.keys(PAISES_INFO)) {
    const slugs = negociosPorPais[codigoPais];
    if (!slugs || slugs.length === 0) continue;
    botonesPaises += `<a href="#pais-${codigoPais}" class="btn-pais">${PAISES_INFO[codigoPais].bandera} ${PAISES_INFO[codigoPais].nombre}</a>`;
  }

  if (!seccionesPaises) {
    seccionesPaises = `<p style="color:${MARCA.textoSuave}">No hay negocios configurados todavía en NEGOCIOS dentro de server.js.</p>`;
  }

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Panel — Tapin</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          ${ESTILO_BASE}
          ${ESTILO_DASHBOARD}
          .content{max-width:none;padding:0;}
          .seccion{margin-bottom:40px;}
          .seccion-header{text-align:left;margin-bottom:20px;}
          .seccion-header h2{font-size:1.1rem;font-weight:700;margin:0 0 4px;}
          .seccion-header p{color:${MARCA.textoSuave};font-size:0.85rem;margin:0;}

          /* Resumen global */
          .dash-cards-4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px;}
          @media (max-width:900px){.dash-cards-4{grid-template-columns:repeat(2,1fr);}}
          .chart-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:10px;padding:20px 22px;margin-top:14px;
                      box-shadow:0 1px 2px rgba(16,24,32,.04);}
          .chart-card-titulo{font-size:0.8rem;font-weight:600;color:${MARCA.textoSuave};margin-bottom:16px;text-align:center;}
          .sparkline-grande{height:110px;max-width:520px;margin:0 auto;}

          /* Lista de negocios */
          .lista-negocios{display:flex;flex-direction:column;gap:14px;}
          .card{background:#fff;border-radius:10px;padding:22px;box-shadow:0 1px 2px rgba(16,24,32,.04);border:1px solid ${MARCA.borde};transition:box-shadow .2s;}
          .card:hover{box-shadow:0 1px 2px rgba(16,24,32,.04), 0 6px 16px rgba(16,24,32,.06);}
          .card-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;}
          .card-nombre{font-weight:700;font-size:1.02rem;letter-spacing:-0.01em;}
          .badge-pro{background:${MARCA.oro};color:#fff;font-size:0.62rem;font-weight:800;padding:2px 7px;border-radius:4px;letter-spacing:0.04em;vertical-align:middle;}
          .badge-basico{background:${MARCA.borde};color:${MARCA.textoSuave};font-size:0.62rem;font-weight:800;padding:2px 7px;border-radius:4px;letter-spacing:0.04em;vertical-align:middle;}
          .card-slug{font-size:0.76rem;color:${MARCA.textoSuave};margin-top:2px;font-family:'SFMono-Regular',Consolas,monospace;}
          .card-total{text-align:right;font-size:1.5rem;font-weight:700;color:${MARCA.texto};line-height:1;}
          .card-total span{display:block;font-size:0.6rem;font-weight:600;color:${MARCA.textoSuave};margin-top:4px;letter-spacing:0.04em;text-transform:uppercase;}
          .card-metrics{display:flex;gap:12px;margin-bottom:22px;max-width:340px;}
          .metric{background:${MARCA.verdeClaro};border-radius:8px;padding:12px 14px;flex:1;text-align:center;}
          .metric-num{font-size:1.2rem;font-weight:700;color:${MARCA.verdeOscuro};}
          .metric-lbl{font-size:0.66rem;color:${MARCA.verde};margin-top:2px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;}
          .sparkline{display:flex;align-items:flex-end;gap:5px;height:84px;margin-bottom:16px;max-width:300px;}
          .sector-badge{font-size:0.74rem;font-weight:700;margin-bottom:14px;}
          .reporte-badge{font-size:0.74rem;font-weight:700;margin-bottom:14px;padding:6px 10px;border-radius:6px;display:inline-block;}
          .reporte-badge.ok{background:${MARCA.verdeClaro};color:${MARCA.verdeOscuro};}
          .reporte-badge.fail{background:#FBEFE9;color:#993C1D;}
          .reporte-badge.pendiente{background:#F3F1EC;color:${MARCA.textoSuave};}
          .card-ultimo{font-size:0.82rem;color:${MARCA.textoSuave};margin-bottom:16px;padding-top:14px;border-top:1px solid ${MARCA.borde};}
          .card-ultimo b{color:${MARCA.texto};}
          .card-actions{display:flex;flex-wrap:wrap;gap:6px;}
          .card-actions a{color:${MARCA.verdeOscuro};font-weight:600;text-decoration:none;font-size:0.74rem;
                          white-space:nowrap;background:${MARCA.verdeClaro};padding:6px 11px;border-radius:6px;}
          .card-actions a:hover{background:${MARCA.verde};color:#fff;}
          .card-actions a.btn-panel-negocio{background:${MARCA.verdeOscuro};color:#fff;border-color:${MARCA.verdeOscuro};font-weight:700;}
          .card-actions a.btn-panel-negocio:hover{background:${MARCA.verde};color:#fff;}
          .card-actions .sin-panel{font-size:0.74rem;color:${MARCA.textoSuave};padding:8px 10px;}
          .seccion-pais{margin-bottom:32px;}
          .pais-header{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;
                       border-bottom:1px solid ${MARCA.borde};padding-bottom:10px;margin-bottom:16px;}
          .pais-titulo{font-size:1rem;font-weight:700;color:${MARCA.texto};}
          .pais-conteo{font-size:0.78rem;color:${MARCA.textoSuave};font-weight:600;}
          .botones-paises{display:flex;flex-wrap:wrap;margin-bottom:20px;}
          .btn-pais{background:#fff;border:1px solid ${MARCA.borde};color:${MARCA.texto};font-weight:600;
                    font-size:0.8rem;padding:8px 16px;border-radius:6px;text-decoration:none;
                    margin:0 8px 8px 0;display:inline-block;}
          .btn-pais:hover{border-color:${MARCA.verdeOscuro};background:${MARCA.verdeClaro};}
          @media (max-width:640px){
            .card{padding:18px;}
            .card-top{flex-wrap:wrap;gap:10px;}
          }
        </style>
      </head>
      <body>
        <div class="dashboard-layout">
          <aside class="sidebar">
            <div class="sidebar-logo">${logoSvg("#FFFFFF", 26)}</div>
            <nav class="sidebar-nav">
              <a href="/stats?key=${key}" class="activo">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
                Resumen
              </a>
              <a href="/descubre" target="_blank">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 010 20a15.3 15.3 0 010-20z"/></svg>
                Mapa público
              </a>
              <a href="/editar?key=${key}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4z"/></svg>
                Editar negocios
              </a>
              <a href="/codigos?key=${key}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/></svg>
                Generar tarjetas
              </a>
              <a href="/auditoria?key=${key}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/></svg>
                Auditoría
              </a>
              <a href="/respaldo?key=${key}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Respaldo
              </a>
            </nav>
            <div class="sidebar-pie">
              <a href="/">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                Cerrar sesión
              </a>
            </div>
          </aside>
          <main class="dashboard-main">
        <div class="content" style="padding:0;max-width:none;">

          <div class="dash-header">
            <div>
              <div class="eyebrow" style="margin-bottom:2px;">Administrador</div>
              <h1>Resumen general</h1>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <span class="dash-header-chip">${totalNegocios} ${totalNegocios === 1 ? "tarjeta activa" : "tarjetas activas"}</span>
              <span class="dash-header-chip" style="font-weight:500;color:${MARCA.textoSuave};">Actualizado al ${new Date().toLocaleDateString("es-CO")}</span>
            </div>
          </div>

          <div class="seccion">
            <div class="dash-cards-4">
              <div class="dash-card"><div class="dash-card-lbl">Tarjetas activas</div><div class="dash-card-num">${totalNegocios}</div></div>
              <div class="dash-card"><div class="dash-card-lbl">Toques totales</div><div class="dash-card-num">${totalToquesGlobal}</div></div>
              <div class="dash-card"><div class="dash-card-lbl">Toques hoy</div><div class="dash-card-num">${totalHoyGlobal}</div></div>
              <div class="dash-card"><div class="dash-card-lbl">Últimos 7 días</div><div class="dash-card-num">${totalSemanaGlobal}</div></div>
            </div>

            <div class="chart-card" style="margin-top:0;text-align:center;">
              <div class="chart-card-titulo">Promedio de estrellas recibidas</div>
              <div style="font-size:1.4rem;font-weight:700;color:${MARCA.oro};">${promedioEstrellas !== null ? promedioEstrellas + " / 5 ★" : "Sin calificaciones filtradas"}</div>
              <div class="suave" style="font-size:0.72rem;margin-top:4px;">Incluye calificaciones positivas y negativas que pasaron el filtro de Tapin${estrellasGlobales.length ? " · " + estrellasGlobales.length + " evaluaciones" : ""}. Las negativas se guardan privadas y no se publican en Google.</div>
            </div>
            <div class="chart-card">
              <div class="chart-card-titulo">Toques combinados de todos los negocios — últimos 7 días</div>
              <div class="sparkline sparkline-grande">${barraSemana(dias7Global)}</div>
            </div>
          </div>

          <div class="seccion">
            <div class="seccion-header">
              <div class="eyebrow">Por país</div>
              <h2>Negocios por país</h2>
              <p>Cada país con su propia sección y sus negocios uno por uno.</p>
            </div>
            <div class="botones-paises">${botonesPaises}</div>
            ${seccionesPaises}
          </div>

        </div>
          </main>
        </div>
      </body>
    </html>
  `);
});


// Historial detallado de un negocio: fecha y hora exacta de cada toque.
// Esto es lo que le puedes mostrar o entregar a tu cliente para justificar la suscripción.
// Visítalo así: https://tu-dominio.com/historial/mi-negocio?key=TU_CLAVE
app.get("/historial/:slug", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }

  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  // El registro detallado toque por toque (fecha, hora, dispositivo) es
  // exclusivo de Plan Pro — el panel básico solo muestra totales/resumen.
  if (!esPro(negocio)) {
    return res.status(402).send(
      `El registro detallado de cada toque es exclusivo del Plan Pro. ` +
      `Súbele el plan a "${negocio.nombre}" desde /editar/${slug}?key=${req.query.key} para activarlo.`
    );
  }

  const datos = leerDatos();
  const eventos = (datos[slug] && datos[slug].eventos) || [];

  // Mostramos los más recientes primero
  const filas = eventos
    .slice()
    .reverse()
    .map(
      (e, i) => `<tr><td>${eventos.length - i}</td><td>${e.fechaLegible}</td><td>${e.dispositivo}</td></tr>`
    )
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <title>Historial — ${negocio.nombre}</title>
        <style>
          body{font-family:sans-serif;background:#F8F4EC;padding:40px;color:#16201C;}
          table{border-collapse:collapse;width:100%;max-width:600px;background:#fff;border-radius:10px;overflow:hidden;}
          th,td{padding:10px 16px;text-align:left;border-bottom:1px solid #eee;font-size:0.92rem;}
          th{background:#16201C;color:#F8F4EC;}
          a{color:#1F6E4E;font-weight:600;}
        </style>
      </head>
      <body>
        <p><a href="/stats?key=${req.query.key}">&larr; Volver al panel</a></p>
        <h1>Historial de toques</h1>
        <p>${negocio.nombre}</p>
        <p>Total: <b>${eventos.length}</b> toques registrados</p>
        <table>
          <tr><th>#</th><th>Fecha y hora</th><th>Dispositivo</th></tr>
          ${filas || "<tr><td colspan='3'>Sin toques registrados todavía</td></tr>"}
        </table>
      </body>
    </html>
  `);
});

// Quejas privadas (calificaciones negativas) de un negocio — nunca se publican en Google.
// Visítalo así: https://tu-dominio.com/quejas/mi-negocio?key=TU_CLAVE
app.get("/quejas/:slug", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!autorizadoProNegocio(req, negocio, slug)) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }

  const datos = leerDatos();
  const quejas = (datos[slug] && datos[slug].quejas) || [];
  const resueltas = quejas.filter((q) => q.estado === "resuelto").length;
  const tasaRecuperacion = quejas.length ? Math.round((resueltas / quejas.length) * 100) : 0;

  const colores = { pendiente: "#C0392B", contactado: "#C9A24B", resuelto: "#0F5132" };
  const fondos = { pendiente: "#FBEFE9", contactado: "#FBF3E1", resuelto: "#E7F0EA" };

  const filas = quejas
    .map((q, i) => i) // índices reales antes de invertir, para los botones de acción
    .reverse()
    .map((i) => {
      const q = quejas[i];
      const estado = q.estado || "pendiente";
      return `<tr>
        <td data-label="Fecha">${q.fechaLegible}</td>
        <td data-label="Comentario">${escaparHtml(q.comentario)}</td>
        <td data-label="Teléfono">${q.telefono ? `<a href="tel:${encodeURIComponent(q.telefono)}">${escaparHtml(q.telefono)}</a>` : "—"}</td>
        <td data-label="Estado"><span style="background:${fondos[estado]};color:${colores[estado]};padding:4px 10px;border-radius:100px;font-size:0.74rem;font-weight:700;">${estado}</span></td>
        <td data-label="Nota">
          <form method="POST" action="/quejas/${slug}/nota?key=${req.query.key}" style="display:flex;gap:4px;">
            <input type="hidden" name="i" value="${i}">
            <input type="text" name="nota" value="${(q.nota || "").replace(/"/g, "&quot;")}" placeholder="Ej: la llamé, le di descuento"
                   style="font-size:0.78rem;padding:6px 8px;border:1px solid ${MARCA.borde};border-radius:6px;width:150px;">
            <button type="submit" style="font-size:0.72rem;padding:6px 10px;background:${MARCA.crema};border:1px solid ${MARCA.borde};border-radius:6px;cursor:pointer;">Guardar</button>
          </form>
        </td>
        <td data-label="Acción">
          ${estado !== "contactado" ? `<form method="POST" action="/quejas/${slug}/estado?key=${req.query.key}" style="display:inline;">
              <input type="hidden" name="i" value="${i}"><input type="hidden" name="estado" value="contactado">
              <button type="submit" style="background:none;border:none;color:${MARCA.verde};font-weight:600;font-size:0.82rem;cursor:pointer;padding:0;margin-right:8px;text-decoration:underline;">Marcar contactado</button>
            </form>` : ""}
          ${estado !== "resuelto" ? `<form method="POST" action="/quejas/${slug}/estado?key=${req.query.key}" style="display:inline;">
              <input type="hidden" name="i" value="${i}"><input type="hidden" name="estado" value="resuelto">
              <button type="submit" style="background:none;border:none;color:${MARCA.verde};font-weight:600;font-size:0.82rem;cursor:pointer;padding:0;text-decoration:underline;">Marcar resuelto</button>
            </form>` : ""}
        </td>
      </tr>`;
    })
    .join("");

  const volverHref = req.query.key === ADMIN_KEY ? `/stats?key=${req.query.key}` : `/mi-panel/${slug}?key=${req.query.key}`;

  res.send(`
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Retroalimentación — ${negocio.nombre}</title>
    <style>
      ${ESTILO_BASE}
      .metrics{display:flex;gap:14px;margin-bottom:24px;max-width:600px;flex-wrap:wrap;}
      .metric{background:#fff;border:1px solid ${MARCA.borde};border-radius:10px;padding:14px;flex:1;min-width:100px;text-align:center;}
      .metric-num{font-size:1.5rem;font-weight:700;color:${MARCA.verde};}
      .metric-lbl{font-size:0.72rem;color:${MARCA.textoSuave};margin-top:4px;}
      table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden;border:1px solid ${MARCA.borde};}
      th,td{padding:10px 16px;text-align:left;border-bottom:1px solid ${MARCA.borde};font-size:0.86rem;}
      th{background:${MARCA.verdeOscuro};color:#fff;font-size:0.72rem;text-transform:uppercase;}
      a{color:${MARCA.verde};font-weight:600;font-size:0.82rem;text-decoration:none;}

      @media (max-width:720px){
        table, thead, tbody, tr{display:block;width:100%;}
        thead{display:none;}
        table{border:none;background:none;}
        tr{background:#fff;border:1px solid ${MARCA.borde};border-radius:12px;margin-bottom:12px;padding:6px 0;overflow:hidden;}
        td{display:flex;justify-content:space-between;align-items:center;gap:12px;
           border-bottom:1px solid ${MARCA.borde};padding:10px 14px;text-align:right;}
        td:last-child{border-bottom:none;}
        td::before{content:attr(data-label);font-weight:700;color:${MARCA.textoSuave};font-size:0.72rem;
                    text-transform:uppercase;letter-spacing:0.02em;text-align:left;flex-shrink:0;}
        td[data-label="Comentario"]{text-align:left;}
        td[data-label="Acción"]{flex-direction:column;align-items:flex-end;gap:6px;}
      }
    </style></head>
    <body>
      <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div><a class="back" href="${volverHref}">&larr; Volver al panel</a></div>
      <div class="content">
        <div class="eyebrow">Rescate de clientes · ${negocio.nombre}</div>
        <h1 class="titulo-pagina">Retroalimentación privada</h1>
        <div class="subtitulo">Cada reseña negativa se queda aquí en vez de publicarse. El dueño recibe un correo al instante para poder reaccionar.</div>
        <div class="metrics">
          <div class="metric"><div class="metric-num">${quejas.length}</div><div class="metric-lbl">Total recibida</div></div>
          <div class="metric"><div class="metric-num">${resueltas}</div><div class="metric-lbl">Resueltas</div></div>
          <div class="metric"><div class="metric-num">${tasaRecuperacion}%</div><div class="metric-lbl">Tasa de recuperación</div></div>
        </div>
        <table><thead><tr><th>Fecha</th><th>Comentario</th><th>Teléfono</th><th>Estado</th><th>Nota</th><th>Acción</th></tr></thead>
        <tbody>${filas || "<tr><td colspan='6'>Sin retroalimentación registrada todavía.</td></tr>"}</tbody>
        </table>
      </div>
    </body></html>
  `);
});

// Cambia el estado de una queja (pendiente -> contactado -> resuelto), para llevar
// el seguimiento de recuperación de clientes insatisfechos.
app.post("/quejas/:slug/estado", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!autorizadoProNegocio(req, negocio, slug)) {
    return res.status(401).send("No autorizado.");
  }
  const i = parseInt(req.body.i, 10);
  const nuevoEstado = req.body.estado;
  if (!["contactado", "resuelto", "pendiente"].includes(nuevoEstado)) {
    return res.status(400).send("Estado inválido.");
  }
  const datos = leerDatos();
  if (datos[slug] && datos[slug].quejas && datos[slug].quejas[i]) {
    datos[slug].quejas[i].estado = nuevoEstado;
    guardarDatos(datos);
  }
  res.redirect(`/quejas/${slug}?key=${req.query.key}`);
});

// Idea 12: nota rápida por queja — memoria de qué se hizo, no solo el estado.
app.post("/quejas/:slug/nota", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!autorizadoProNegocio(req, negocio, slug)) {
    return res.status(401).send("No autorizado.");
  }
  const i = parseInt(req.body.i, 10);
  const nota = (req.body.nota || "").trim();
  const datos = leerDatos();
  if (datos[slug] && datos[slug].quejas && datos[slug].quejas[i]) {
    datos[slug].quejas[i].nota = nota;
    guardarDatos(datos);
  }
  res.redirect(`/quejas/${slug}?key=${req.query.key}`);
});


// Panel individual de UN SOLO negocio, usando su propia clave (no la clave maestra).
// Así puedes darle este enlace al dueño sin que vea los datos de tus otros negocios.
// Incluye recomendaciones automáticas generadas a partir de sus propios datos.
// Visítalo así: https://tu-dominio.com/mi-panel/mi-negocio?key=CLAVE_DE_ESE_NEGOCIO
app.get("/mi-panel/:slug", limitarIntentos(20, 15), (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return enviarError(res, 404, "No encontramos este negocio", "Revisa que el enlace a tu panel esté completo y bien escrito.");

  // Acepta la clave completa, la clave de solo lectura (idea 5), o la cookie
  // de sesión que se guarda la primera vez. Usa el mismo verificador cifrado
  // (scrypt + tiempo constante) que el resto del panel de negocio, en vez de
  // comparar la clave en texto plano — así un negocio ya migrado a clave
  // cifrada puede seguir entrando a su panel principal sin quedar bloqueado.
  // También aceptamos el ADMIN_KEY en enlaces antiguos del panel admin para
  // que no se rompan los accesos ya generados. Los enlaces nuevos usan la
  // cookie de sesión y no exponen esa clave.
  const adminAutorizado = adminSesionValida(req) || req.query.key === ADMIN_KEY;
  const claveUsada = adminAutorizado
    ? generarLinkAccesoNegocio(slug, 1, true)
    : claveEfectiva(req, slug);
  const autorizado = adminAutorizado || claveNegocioValida(negocio, slug, claveUsada) ||
    (negocio.claveSoloLectura && claveUsada === negocio.claveSoloLectura);
  if (!tieneClaveConfigurada(negocio) || !autorizado) {
    return enviarError(res, 401, "No pudimos verificar tu acceso", "El enlace a tu panel debe incluir tu clave personal. Revisa el correo o mensaje donde Tapin te la envió, o pídesela de nuevo a tu proveedor.");
  }
  // Los botones del panel necesitan conservar una autorización; para el
  // administrador usamos un token temporal por negocio, nunca su clave.
  if (claveUsada && autorizado && claveUsada !== negocio.claveSoloLectura && !String(claveUsada).startsWith("tok_")) ponerCookieSesion(res, slug, claveUsada);

  const datos = leerDatos();
  const eventos = (datos[slug] && datos[slug].eventos) || [];
  const r = calcularResumen(eventos);
  const ultimoTexto = r.ultimo ? r.ultimo.fechaLegible : "Sin toques todavía";
  const recomendaciones = generarRecomendaciones(eventos, r, negocio);
  const horas = analizarHoras(eventos, negocio);

  // Variación real vs. ayer y vs. la semana anterior — usa r.dias7 (que ya
  // trae [hace 6 días, ..., ayer, hoy]) y el mismo cálculo de "semana
  // anterior" que ya usa generarRecomendaciones más abajo, solo que aquí se
  // expone como número para mostrarlo junto a las tarjetas del resumen.
  const ayerToques = r.dias7[5] || 0;
  const cambioVsAyer = ayerToques > 0 ? Math.round(((r.hoy - ayerToques) / ayerToques) * 100) : null;
  const inicioHoyCmp = new Date();
  inicioHoyCmp.setHours(0, 0, 0, 0);
  const inicioSemanaAnteriorCmp = new Date(inicioHoyCmp);
  inicioSemanaAnteriorCmp.setDate(inicioSemanaAnteriorCmp.getDate() - 13);
  const finSemanaAnteriorCmp = new Date(inicioHoyCmp);
  finSemanaAnteriorCmp.setDate(finSemanaAnteriorCmp.getDate() - 6);
  const semanaAnteriorToques = eventos.filter((e) => {
    const f = new Date(e.fechaISO);
    return f >= inicioSemanaAnteriorCmp && f < finSemanaAnteriorCmp;
  }).length;
  const cambioVsSemanaAnterior = semanaAnteriorToques > 0
    ? Math.round(((r.semana - semanaAnteriorToques) / semanaAnteriorToques) * 100)
    : null;

  const testimonios = (datos[slug] && datos[slug].testimonios) || [];
  const quejas = (datos[slug] && datos[slug].quejas) || [];
  const totalCalificado = testimonios.length + quejas.length;
  const promedioEstrellas = promedioEstrellasFiltradas(testimonios, quejas);
  const pctPositivas = totalCalificado ? Math.round((testimonios.length / totalCalificado) * 100) : 0;
  const pctNegativas = totalCalificado ? 100 - pctPositivas : 0;
  const quejasResueltas = quejas.filter((q) => q.estado === "resuelto").length;
  const tasaRecuperacion = quejas.length ? Math.round((quejasResueltas / quejas.length) * 100) : null;

  // Si el mismo correo tiene otras tarjetas activadas, se las mostramos aquí
  // para que un negocio con varias sedes no tenga que ir sede por sede.
  const todosNegocios = todosLosNegocios();
  const otrasSedes = negocio.email
    ? Object.keys(todosNegocios).filter(
        (s) => s !== slug && (todosNegocios[s].email || "").trim().toLowerCase() === negocio.email.trim().toLowerCase()
      )
    : [];

  const iconoActividad = `<svg viewBox="0 0 24 24" fill="none" stroke="${MARCA.verde}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="3"/><line x1="11" y1="18" x2="13" y2="18"/></svg>`;
  const flechaActividad = `<svg viewBox="0 0 24 24" fill="none" stroke="${MARCA.textoSuave}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  const actividadReciente = eventos
    .slice(-6)
    .reverse()
    .map((e) => `
      <div class="actividad-item">
        <div class="actividad-icono">${iconoActividad}</div>
        <div class="actividad-texto">
          <div class="actividad-titulo">Toque registrado</div>
          <div class="actividad-sub">${escaparHtml(e.dispositivo)} · ${tiempoRelativo(e.fechaISO)}</div>
        </div>
        <div class="actividad-flecha">${flechaActividad}</div>
      </div>`)
    .join("");

  const recomendacionesHtml = recomendaciones
    .map((texto) => `<div class="reco">${texto}</div>`)
    .join("");

  const promSector = esPro(negocio) ? promedioSector(negocio.categoria, slug, datos) : null;
  const radar = esPro(negocio) ? radarSector(negocio, slug, todosNegocios, datos) : null;

  // Ideas 5-9: solo tienen sentido para negocios Pro (van en esa sección del panel).
  const diaFlojo = esPro(negocio) ? diaMasFlojo(eventos, negocio) : null;
  const caida = esPro(negocio) && !negocio.pausado ? alertaCaidaPropia(eventos, r.semana) : null;
  const clientesRecurrentes = esPro(negocio) ? contarClientesRecurrentes(slug) : 0;
  const percentil = esPro(negocio) ? percentilCategoria(negocio, slug, todosNegocios, datos) : null;

  // Idea 9: resumen de los últimos 30 días en una sola frase, combinando lo
  // que ya calculamos (mejor no repetir cálculos: reutiliza horas y r).
  let resumenFrase = null;
  if (esPro(negocio) && r.total > 0) {
    const partes = [`${r.semana} toques esta semana`];
    if (horas.totalMes > 0) partes.push(`pico ${horas.picoHora}:00`);
    if (totalCalificado > 0) partes.push(`${pctPositivas}% positivas`);
    resumenFrase = partes.join(" · ");
  }

  // Ideas 1, 4, 20, 21: comparación mensual, calendario, meta y año anterior.
  const comparativoMes = compararMesAnterior(eventos, negocio);
  const calendario = calendarioMes(eventos, negocio);
  const meta = progresoMeta(eventos, negocio.metaMensual);
  const comparativoAnio = compararAnioAnterior(eventos, negocio);
  const opcionesProyeccion = ["dia", "semana", "mes", "semestre", "anio"];
  const periodoProyeccion = opcionesProyeccion.includes(req.query.proyeccion) ? req.query.proyeccion : "mes";
  const proyeccion = proyeccionPeriodo(eventos, negocio, periodoProyeccion);
  const soloLectura = claveUsada === negocio.claveSoloLectura && negocio.claveSoloLectura;

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Mi Panel — ${negocio.nombre}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          ${ESTILO_BASE}
          .content{max-width:1120px;width:100%;}
          .seccion{margin-bottom:26px;}
          .seccion-header{text-align:center;margin-bottom:14px;}
          .seccion-header .eyebrow{justify-content:center;}
          .seccion-header h2{font-size:1.1rem;font-weight:700;margin:0 0 4px;}
          .seccion-header p{color:${MARCA.textoSuave};font-size:0.85rem;margin:0;}

          .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:stretch;}
          @media (max-width:640px){.grid-2{grid-template-columns:1fr;}}
          .panel-analitica-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;margin-top:6px;margin-bottom:26px;}
          .panel-analitica-grid>div{min-width:0;}
          .panel-analitica-grid>.panel-analitica-full{grid-column:1 / -1;}
          .seccion-datos .grid-3{grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch;}.seccion-datos .grid-3 .reco{margin-bottom:0;min-height:64px;display:flex;align-items:center;line-height:1.4;}
          @media (max-width:700px){.panel-analitica-grid{grid-template-columns:1fr;}.panel-analitica-grid>div{grid-column:1;}.seccion-datos .grid-3{grid-template-columns:1fr;}}
          .grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;align-items:stretch;}
          .grid-3 .reco{margin-bottom:0;height:100%;box-sizing:border-box;}
          @media (max-width:900px){.grid-3{grid-template-columns:1fr 1fr;}}
          @media (max-width:560px){.grid-3{grid-template-columns:1fr;}}
          @media (max-width:480px){
            .fila-herramientas{flex-direction:column;}
            .btn-herramienta{min-width:0;}
            .resumen-num{font-size:1.3rem;}
            .content{padding:24px 18px 50px;}
          }

          .card-titulo{font-size:0.86rem;font-weight:700;color:${MARCA.verdeOscuro};margin-bottom:12px;
                       display:flex;align-items:center;justify-content:space-between;
                       padding-left:10px;border-left:3px solid ${MARCA.verde};}
          .card-titulo span.suave{font-weight:600;color:${MARCA.oro};font-size:0.72rem;}

          .resumen-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
          .resumen-box{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;padding:14px 8px;text-align:center;
                       box-shadow:0 1px 2px rgba(11,61,44,0.04);}
          .resumen-num{font-size:1.5rem;font-weight:700;color:${MARCA.verdeOscuro};line-height:1;}
          .resumen-lbl{font-size:0.64rem;color:${MARCA.textoSuave};margin-top:5px;font-weight:600;text-transform:uppercase;letter-spacing:0.02em;}

          .chart-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;padding:16px 18px;margin-top:12px;
                      box-shadow:0 1px 2px rgba(11,61,44,0.04);box-sizing:border-box;}
          .grid-2 .chart-card{height:100%;}
          .chart-card-titulo{font-size:0.78rem;font-weight:600;color:${MARCA.textoSuave};margin-bottom:12px;text-align:center;}
          .sparkline{display:flex;align-items:flex-end;gap:5px;}
          .sparkline-grande{height:70px;}

          .ultimo-toque{text-align:center;font-size:0.8rem;color:${MARCA.textoSuave};margin-top:10px;}
          .ultimo-toque b{color:${MARCA.texto};}

          .reco{background:${MARCA.verdeClaro};border-left:3px solid ${MARCA.verde};border-radius:8px;padding:12px 14px;
                font-size:0.83rem;margin-bottom:8px;color:${MARCA.verdeOscuro};}

          .horas-chart{display:flex;align-items:flex-end;gap:2px;height:60px;max-width:440px;margin:0 auto;}
          .horas-labels{display:flex;justify-content:space-between;font-size:0.6rem;color:${MARCA.textoSuave};margin:6px auto 0;max-width:440px;}
          .horas-nota{text-align:center;font-size:0.76rem;color:${MARCA.textoSuave};margin-top:10px;}
          .horas-nota b{color:${MARCA.texto};}

          .dia-flojo-nota{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid ${MARCA.borde};font-size:0.78rem;color:${MARCA.texto};}
          .dia-flojo-nota b{color:${MARCA.oro};}
          .dia-flojo-nota .suave{color:${MARCA.textoSuave};font-size:0.74rem;}

          .sentimiento-barra{display:flex;height:14px;border-radius:100px;overflow:hidden;background:${MARCA.borde};}
          .sentimiento-leyenda{display:flex;flex-direction:column;gap:6px;margin-top:10px;font-size:0.78rem;color:${MARCA.textoSuave};}
          .sentimiento-leyenda span{display:flex;align-items:center;gap:6px;}
          .sentimiento-leyenda i{width:9px;height:9px;border-radius:50%;display:inline-block;flex-shrink:0;}
          .sentimiento-vacio{text-align:center;font-size:0.8rem;color:${MARCA.textoSuave};padding:6px 0;}

          .radar-sector{display:flex;flex-direction:column;}
          .radar-fila{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid ${MARCA.borde};flex-wrap:wrap;}
          .radar-fila:last-child{border-bottom:none;}
          .radar-etiqueta{font-size:0.8rem;font-weight:600;color:${MARCA.texto};min-width:150px;}
          .radar-valores{display:flex;align-items:center;gap:10px;font-size:0.78rem;color:${MARCA.textoSuave};}
          .radar-valores b{color:${MARCA.texto};}
          .radar-vs{font-size:0.9rem;font-weight:700;}
          .radar-sin-dato{font-size:0.76rem;color:${MARCA.textoSuave};font-style:italic;}

          .par-simetrico{display:flex;gap:16px;flex-wrap:wrap;align-items:stretch;}
          .par-simetrico-item{flex:1;min-width:280px;display:flex;flex-direction:column;}
          .par-simetrico-item .chart-card{flex:1;}
          @media (max-width:700px){.par-simetrico{flex-direction:column;}}

          .card-titulo a.ver-mas{font-size:0.72rem;font-weight:700;color:${MARCA.verde};text-decoration:none;}
          .card-titulo a.ver-mas:hover{text-decoration:underline;}
          .actividad-lista{padding:4px 18px;}
          .actividad-item{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid ${MARCA.borde};}
          .actividad-item:last-child{border-bottom:none;}
          .actividad-icono{flex-shrink:0;width:34px;height:34px;border-radius:50%;background:${MARCA.verdeClaro};
                           display:flex;align-items:center;justify-content:center;}
          .actividad-icono svg{width:16px;height:16px;}
          .actividad-texto{flex:1;min-width:0;}
          .actividad-titulo{font-size:0.84rem;font-weight:600;color:${MARCA.texto};}
          .actividad-sub{font-size:0.74rem;color:${MARCA.textoSuave};margin-top:2px;}
          .actividad-flecha{flex-shrink:0;width:16px;height:16px;opacity:0.5;}
          .actividad-flecha svg{width:100%;height:100%;}

          .tabla-actividad{width:100%;border-collapse:collapse;font-size:0.78rem;table-layout:fixed;}
          .tabla-actividad th:first-child, .tabla-actividad td:first-child{width:58%;}
          .tabla-actividad th:last-child, .tabla-actividad td:last-child{width:42%;}
          .tabla-actividad th{text-align:left;color:${MARCA.textoSuave};font-weight:600;font-size:0.66rem;
                               text-transform:uppercase;letter-spacing:0.03em;padding:0 0 6px;border-bottom:1px solid ${MARCA.borde};}
          .tabla-actividad td{padding:7px 10px 7px 0;border-bottom:1px solid ${MARCA.borde};color:${MARCA.texto};}
          .tabla-actividad tr:last-child td{border-bottom:none;}

          .fila-herramientas{display:flex;gap:10px;flex-wrap:wrap;}
          .btn-herramienta{flex:1;min-width:140px;background:#fff;border:1px solid ${MARCA.borde};border-radius:12px;
                           padding:12px 14px;text-decoration:none;color:${MARCA.texto};font-size:0.82rem;font-weight:700;
                           text-align:center;box-shadow:0 1px 2px rgba(11,61,44,0.04);}
          .btn-herramienta:hover{border-color:${MARCA.verde};}
          .btn-reporte-pdf{display:flex;align-items:center;justify-content:space-between;gap:12px;
                           background:${MARCA.verdeOscuro};color:#fff;border-radius:14px;padding:16px 20px;
                           text-decoration:none;margin-top:12px;}
          .btn-reporte-pdf b{font-size:0.92rem;}
          .btn-reporte-pdf span{font-size:0.76rem;color:#CFE3D6;display:block;margin-top:2px;}
          .btn-reporte-pdf .flecha{font-size:1.3rem;flex-shrink:0;}

          ${ESTILO_DASHBOARD}
        </style>
      </head>
      <body>
        <div class="dashboard-layout">
          <aside class="sidebar">
            <div class="sidebar-logo">${logoSvg("#FFFFFF", 26)}</div>
            <nav class="sidebar-nav">
              <a href="/mi-panel/${slug}?key=${claveUsada}" class="activo">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
                Resumen
              </a>
              <a href="/mi-panel/${slug}?key=${claveUsada}#actividad">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
                Actividad
              </a>
              ${!soloLectura ? `
              <a href="${esPro(negocio) ? `/suscripcion/${slug}?key=${claveUsada}` : `/mejorar-a-pro/${slug}?key=${claveUsada}`}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                ${esPro(negocio) ? "Mi suscripción" : "Plan de pago"}
              </a>
              <a href="/mi-panel/${slug}/configuracion?key=${claveUsada}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>
                Configuración
              </a>
              ` : ""}
            </nav>
            <div class="sidebar-pie">
              <a href="/">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                Cerrar sesión
              </a>
            </div>
          </aside>
          <main class="dashboard-main">
        <div class="content" style="padding:0;max-width:none;">

          <div class="dash-header">
            <div>
              <div class="eyebrow" style="margin-bottom:2px;">${escaparHtml(negocio.nombre)}</div>
              <h1>Resumen</h1>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              ${negocio.pausado ? `<span class="dash-header-chip" style="background:#FBEFE9;color:#993C1D;border-color:#F0D5C8;">Pausado</span>` : ""}
              ${soloLectura ? `<span class="dash-header-chip">Solo lectura</span>` : ""}
              <span class="dash-header-chip" style="${esPro(negocio) ? "" : `color:${MARCA.textoSuave};`}">${esPro(negocio) ? "Plan Pro" : "Plan Básico"}</span>
              <span class="dash-header-chip" style="font-weight:500;color:${MARCA.textoSuave};">Actualizado al ${new Date().toLocaleDateString("es-CO", { timeZone: zonaDe(negocio) })}</span>
            </div>
          </div>

          ${!soloLectura ? `
          <div style="margin:0 0 22px;display:flex;gap:10px;flex-wrap:wrap;">
            <a href="/mi-panel/${slug}/editar?key=${claveUsada}"
               style="font-size:0.76rem;font-weight:600;color:${MARCA.verdeOscuro};background:#fff;
                      border:1px solid ${MARCA.borde};border-radius:8px;padding:8px 16px;text-decoration:none;">
              Editar mi negocio
            </a>
            <a href="/mi-panel/${slug}/clave?key=${claveUsada}"
               style="font-size:0.76rem;font-weight:600;color:${MARCA.verdeOscuro};background:#fff;
                      border:1px solid ${MARCA.borde};border-radius:8px;padding:8px 16px;text-decoration:none;">
              Cambiar mi clave
            </a>
          </div>
          ` : ""}

          ${otrasSedes.length > 0 ? `
          <div class="seccion">
            <div class="card-titulo">Tus otras sedes <span class="suave">${otrasSedes.length + 1} en total</span></div>
            <div class="chart-card" style="margin-top:0;padding:8px;">
              ${otrasSedes
                .map((s) => {
                  const otroNegocio = todosNegocios[s];
                  const rOtro = calcularResumen((datos[s] && datos[s].eventos) || []);
                  return `<a href="/mi-panel/${s}?key=${otroNegocio.claveAcceso || ""}"
                             style="display:flex;justify-content:space-between;align-items:center;text-decoration:none;
                                    color:${MARCA.texto};padding:10px 10px;border-radius:8px;">
                            <span style="font-size:0.85rem;font-weight:600;">${otroNegocio.nombre}</span>
                            <span style="font-size:0.76rem;color:${MARCA.textoSuave};">${rOtro.total} toques →</span>
                          </a>`;
                })
                .join("")}
            </div>
          </div>
          ` : ""}

          <div class="dash-cards">
            <div class="dash-card">
              <div class="dash-card-lbl">Hoy</div>
              <div class="dash-card-num">${r.hoy}</div>
              <div class="dash-card-sub">interacciones</div>
              ${cambioVsAyer !== null ? `<div class="dash-card-delta ${cambioVsAyer >= 0 ? "up" : "down"}">${cambioVsAyer >= 0 ? "▲" : "▼"} ${cambioVsAyer >= 0 ? "+" : ""}${cambioVsAyer}% vs. ayer</div>` : ""}
            </div>
            <div class="dash-card">
              <div class="dash-card-lbl">Últimos 7 días</div>
              <div class="dash-card-num">${r.semana}</div>
              <div class="dash-card-sub">interacciones</div>
              ${cambioVsSemanaAnterior !== null ? `<div class="dash-card-delta ${cambioVsSemanaAnterior >= 0 ? "up" : "down"}">${cambioVsSemanaAnterior >= 0 ? "▲" : "▼"} ${cambioVsSemanaAnterior >= 0 ? "+" : ""}${cambioVsSemanaAnterior}% vs. semana anterior</div>` : ""}
            </div>
            <div class="dash-card">
              <div class="dash-card-lbl">Calificación promedio</div>
              ${promedioEstrellas !== null ? `
                <div class="dash-card-num">${promedioEstrellas}</div>
                <div class="dash-card-estrellas">${"★".repeat(Math.round(promedioEstrellas))}${"☆".repeat(5 - Math.round(promedioEstrellas))}</div>
                <div class="dash-card-sub">basado en ${testimonios.length + quejas.length} opinion${testimonios.length + quejas.length === 1 ? "" : "es"}</div>
              ` : `<div class="dash-card-sub" style="margin-top:6px;">Sin calificaciones filtradas todavía</div>`}
            </div>
          </div>

          <div class="dash-charts" id="actividad">
            <div class="dash-panel">
              <div class="dash-panel-top">
                <div>
                  <div class="dash-panel-titulo">Actividad</div>
                  <div class="dash-panel-sub">Últimos 7 días</div>
                </div>
                <div>
                  <div class="dash-panel-num">${r.semana}</div>
                  <div class="dash-panel-numlbl">interacciones</div>
                </div>
              </div>
              <div class="dash-actividad-bars sparkline">${barraSemana(r.dias7)}</div>
              <div class="ultimo-toque" style="margin-top:12px;">Total histórico: <b>${r.total}</b> · Último toque: <b>${ultimoTexto}</b></div>
            </div>

            <div class="dash-panel">
              <div class="dash-panel-top">
                <div>
                  <div class="dash-panel-titulo">Proyección</div>
                  <div class="dash-panel-sub">Proyectas ${proyeccion.etiqueta}</div>
                </div>
                <div>
                  <div class="dash-panel-num">${proyeccion.suficiente ? proyeccion.proyectado : "—"}</div>
                  ${comparativoMes.disponible
                    ? `<div class="dash-panel-numlbl" style="color:${comparativoMes.cambioPct >= 0 ? MARCA.verde : MARCA.rojo};font-weight:700;">${comparativoMes.cambioPct >= 0 ? "+" : ""}${comparativoMes.cambioPct}% vs. mes anterior</div>`
                    : `<div class="dash-panel-numlbl">interacciones</div>`}
                </div>
              </div>
              ${calendario.dias.some((v) => v > 0)
                ? graficaLinea(calendario.dias, { alto: 90, color: MARCA.verde })
                : `<div style="text-align:center;color:${MARCA.textoSuave};font-size:0.8rem;padding:20px 0;">Todavía no hay suficientes datos este mes.</div>`}
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:14px;">
                ${[["dia","1 día"],["semana","1 semana"],["mes","1 mes"],["semestre","6 meses"],["anio","1 año"]].map(([valor, texto]) => `<a href="/mi-panel/${slug}?key=${encodeURIComponent(claveUsada)}&proyeccion=${valor}#actividad" style="text-decoration:none;font-size:0.68rem;font-weight:600;padding:6px 10px;border-radius:6px;border:1px solid ${periodoProyeccion === valor ? MARCA.verde : MARCA.borde};background:${periodoProyeccion === valor ? MARCA.verdeClaro : "#fff"};color:${MARCA.verdeOscuro};">${texto}</a>`).join("")}
              </div>
              ${proyeccion.suficiente
                ? `<div class="ultimo-toque" style="margin-top:12px;">Rango orientativo: <b>${proyeccion.minimo}–${proyeccion.maximo}</b> toques · promedio actual <b>${proyeccion.promedio}/día</b> · ${proyeccion.restantes} días restantes</div>`
                : `<div class="ultimo-toque" style="margin-top:12px;">Estamos reuniendo datos — cuando haya al menos 3 días y 3 toques registrados este período, aquí verás la estimación.</div>`}
            </div>
          </div>

          ${comparativoMes.disponible ? `
          <div class="seccion">
            <div class="card-titulo">Este mes vs. el anterior</div>
            <div class="chart-card" style="margin-top:0;display:flex;gap:20px;align-items:center;">
              <div style="text-align:center;flex:1;">
                <div style="font-size:1.4rem;font-weight:800;color:${MARCA.verdeOscuro};">${comparativoMes.mesActual}</div>
                <div style="font-size:0.7rem;color:${MARCA.textoSuave};text-transform:uppercase;">Este mes</div>
              </div>
              <div style="text-align:center;flex:1;">
                <div style="font-size:1.4rem;font-weight:800;color:${MARCA.textoSuave};">${comparativoMes.mesAnterior}</div>
                <div style="font-size:0.7rem;color:${MARCA.textoSuave};text-transform:uppercase;">Mes anterior</div>
              </div>
              <div style="text-align:center;flex:1;">
                <div style="font-size:1.1rem;font-weight:800;color:${comparativoMes.cambioPct >= 0 ? MARCA.verde : MARCA.rojo};">
                  ${comparativoMes.cambioPct >= 0 ? "+" : ""}${comparativoMes.cambioPct}%
                </div>
                <div style="font-size:0.7rem;color:${MARCA.textoSuave};text-transform:uppercase;">Cambio</div>
              </div>
            </div>
            ${comparativoAnio ? `<div class="ultimo-toque" style="margin-top:10px;">Vs. el mismo mes del año pasado: <b>${comparativoAnio.cambioPct >= 0 ? "+" : ""}${comparativoAnio.cambioPct}%</b></div>` : ""}
          </div>
          ` : ""}


          ${!esPro(negocio) ? `
          <div class="seccion">
            <div class="card-titulo">Calendario del mes</div>
            <div class="chart-card" style="margin-top:0;">
              <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px;max-width:340px;margin:0 auto;">
                ${Array.from({ length: calendario.primerDiaSemana }, () => `<div></div>`).join("")}
                ${calendario.dias.map((v, i) => {
                  const intensidad = v === 0 ? 0 : Math.max(0.15, v / calendario.max);
                  const nivel = v === 0 ? 0 : Math.max(1, Math.ceil(intensidad * 4));
                  return `<div class="cal-dia ${v === 0 ? "cal-vacio" : `cal-activo cal-nivel-${nivel}`}" title="${i + 1}: ${v} toques" style="aspect-ratio:1;border-radius:6px;
                          background:${v === 0 ? MARCA.borde : `rgba(15,81,50,${intensidad})`};
                          display:flex;align-items:center;justify-content:center;font-size:0.66rem;font-weight:600;
                          color:${intensidad > 0.5 ? "#fff" : MARCA.textoSuave};">${i + 1}</div>`;
                }).join("")}
              </div>
              <div class="cal-leyenda" style="text-align:center;font-size:0.72rem;color:${MARCA.textoSuave};margin-top:14px;">Más oscuro = más toques</div>
            </div>
          </div>
          ` : ""}

          ${r.total === 0 ? `
          <div class="seccion">
            <div class="card-titulo">Primeros pasos</div>
            <div class="grid-3">
              <div class="reco" style="border-left-color:${MARCA.oro};background:#FBF6E9;color:#7A5A00;">
                Comparte el link de tu tarjeta con tus primeros clientes: <b>${req.protocol}://${req.get("host")}/r/${slug}</b>
              </div>
              <div class="reco" style="border-left-color:${MARCA.oro};background:#FBF6E9;color:#7A5A00;">
                Verifica que tu <a href="/mi-panel/${slug}/editar?key=${claveUsada}" style="color:#7A5A00;">enlace de reseñas de Google</a> sea el correcto antes del primer toque.
              </div>
              <div class="reco" style="border-left-color:${MARCA.oro};background:#FBF6E9;color:#7A5A00;">
                Invita a un cliente frecuente a dejar tu primera reseña — así pruebas que todo el flujo funciona.
              </div>
            </div>
          </div>
          ` : ""}

          ${esPro(negocio) ? `
          ${resumenFrase || caida || diaFlojo || clientesRecurrentes > 0 || percentil !== null ? `
          <div class="seccion seccion-datos">
            <div class="card-titulo">Lo que dicen tus datos</div>
            <div class="grid-3">
              ${resumenFrase ? `<div class="reco" style="border-left-color:${MARCA.verde};"><b>Resumen (30 días):</b> ${resumenFrase}</div>` : ""}
              ${caida ? `<div class="reco" style="border-left-color:${MARCA.rojo};background:#FBEFE9;color:#993C1D;">
                <b>⚠ Caída esta semana</b> — ${caida.pctCaida}% por debajo de tu propio promedio (~${caida.promedioSemanal} toques/semana).
              </div>` : ""}
              ${diaFlojo ? `<div class="reco" style="border-left-color:${MARCA.oro};background:#FBF6E9;color:#7A5A00;">
                Tu día más flojo históricamente es el <b>${diaFlojo.dia}</b> — considera una promo esos días.
              </div>` : ""}
              ${clientesRecurrentes > 0 ? `<div class="reco" style="border-left-color:${MARCA.verde};">
                Tienes <b>${clientesRecurrentes} ${clientesRecurrentes === 1 ? "cliente" : "clientes"}</b> que ya te calificaron 3 veces o más — son tus más fieles.
              </div>` : ""}
              ${percentil !== null ? `<div class="reco" style="border-left-color:${MARCA.verde};">
                Estás en el <b>${percentil >= 50 ? "top " + (100 - percentil + 1) + "%" : "resto"}</b> de los negocios de tu categoría en toques esta semana.
              </div>` : ""}
            </div>
          </div>
          ` : ""}
          <div class="panel-analitica-grid">
            <div>
              <div class="card-titulo">Calendario del mes</div>
              <div class="chart-card" style="margin-top:0;">
                <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px;max-width:290px;margin:0 auto;">
                  ${Array.from({ length: calendario.primerDiaSemana }, () => `<div></div>`).join("")}
                  ${calendario.dias.map((v, i) => {
                    const intensidad = v === 0 ? 0 : Math.max(0.15, v / calendario.max);
                    const nivel = v === 0 ? 0 : Math.max(1, Math.ceil(intensidad * 4));
                    return `<div class="cal-dia ${v === 0 ? "cal-vacio" : `cal-activo cal-nivel-${nivel}`}" title="${i + 1}: ${v} toques" style="aspect-ratio:1;border-radius:6px;
                            background:${v === 0 ? MARCA.borde : `rgba(15,81,50,${intensidad})`};
                            display:flex;align-items:center;justify-content:center;font-size:0.62rem;font-weight:600;
                            color:${intensidad > 0.5 ? "#fff" : MARCA.textoSuave};">${i + 1}</div>`;
                  }).join("")}
                </div>
                <div class="cal-leyenda" style="text-align:center;font-size:0.72rem;color:${MARCA.textoSuave};margin-top:14px;">Más oscuro = más toques</div>
              </div>
            </div>
            <div>
              <div class="card-titulo">Tus horas pico <span class="suave">últimos 30 días</span></div>
              <div class="chart-card" style="margin-top:0;">
                <div class="horas-chart">${barraHoras(horas.porHora, horas.picoHora)}</div>
                <div class="horas-labels"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>
                ${horas.totalMes > 0
                  ? `<div class="horas-nota">Pico: <b>${horas.picoHora}:00</b> (${horas.maxToques} toques)</div>`
                  : `<div class="horas-nota">Todavía no hay suficientes toques este mes.</div>`}
                ${diaFlojo ? `<div class="dia-flojo-nota">
                  <span>Tu día más flojo es el <b>${diaFlojo.dia}</b></span>
                  <span class="suave">${diaFlojo.toques} toques acumulados</span>
                </div>` : esPro(negocio) ? `<div class="dia-flojo-nota">
                  <span class="suave">Verás tu día más flojo en cuanto tengas actividad en al menos 3 días distintos.</span>
                </div>` : ""}
              </div>
            </div>

            ${promSector !== null ? `
            ${meta ? `
            <div class="panel-analitica-full">
              <div class="par-simetrico">
                <div class="par-simetrico-item">
                  <div class="card-titulo">Cómo te calificaron</div>
                  <div class="chart-card" style="margin-top:0;">
                    ${totalCalificado > 0
                      ? `<div class="sentimiento-barra">
                           <div style="width:${pctPositivas}%;background:${MARCA.verde};"></div>
                           <div style="width:${pctNegativas}%;background:${MARCA.rojo};"></div>
                         </div>
                         <div class="sentimiento-leyenda">
                           <span><i style="background:${MARCA.verde};"></i>Positivas: ${testimonios.length} (${pctPositivas}%)</span>
                           <span><i style="background:${MARCA.rojo};"></i>Quejas: ${quejas.length} (${pctNegativas}%)</span>
                         </div>
                         ${tasaRecuperacion !== null ? `<div class="horas-nota">Tasa de recuperación: <b>${tasaRecuperacion}%</b> de las quejas resueltas</div>` : ""}`
                      : `<div class="sentimiento-vacio">Todavía no hay calificaciones registradas.</div>`}
                  </div>
                </div>
                <div class="par-simetrico-item">
                  <div class="card-titulo">Meta del mes</div>
                  <div class="chart-card" style="margin-top:0;">
                    <div style="display:flex;justify-content:space-between;font-size:0.82rem;margin-bottom:6px;">
                      <span>${meta.toquesMes} de ${meta.metaMensual} toques</span><b>${meta.pct}%</b>
                    </div>
                    <div style="height:10px;border-radius:100px;background:${MARCA.borde};overflow:hidden;">
                      <div style="height:100%;border-radius:100px;background:${meta.pct >= 100 ? MARCA.oro : MARCA.verde};width:${meta.pct}%;"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            ` : `
            <div class="panel-analitica-full">
              <div class="card-titulo">Cómo te calificaron</div>
              <div class="chart-card" style="margin-top:0;">
                ${totalCalificado > 0
                  ? `<div class="sentimiento-barra">
                       <div style="width:${pctPositivas}%;background:${MARCA.verde};"></div>
                       <div style="width:${pctNegativas}%;background:${MARCA.rojo};"></div>
                     </div>
                     <div class="sentimiento-leyenda">
                       <span><i style="background:${MARCA.verde};"></i>Positivas: ${testimonios.length} (${pctPositivas}%)</span>
                       <span><i style="background:${MARCA.rojo};"></i>Quejas: ${quejas.length} (${pctNegativas}%)</span>
                     </div>
                     ${tasaRecuperacion !== null ? `<div class="horas-nota">Tasa de recuperación: <b>${tasaRecuperacion}%</b> de las quejas resueltas</div>` : ""}`
                  : `<div class="sentimiento-vacio">Todavía no hay calificaciones registradas.</div>`}
              </div>
            </div>
            `}

            <div class="panel-analitica-full">
              <div class="card-titulo">Tú vs. tu sector <span class="suave">${radar ? `· ${radar.negociosComparados} negocios parecidos` : ""}</span></div>
              <div class="chart-card" style="margin-top:0;">
                ${radar ? `<div class="radar-sector">
                  ${[
                    { etiqueta: "Tráfico semanal", propio: radar.trafico.propio, sector: radar.trafico.sector, fmt: (v) => `${Math.round(v)} toques` },
                    { etiqueta: "Calificación", propio: radar.calificacion.propio, sector: radar.calificacion.sector, fmt: (v) => `${v.toFixed(1)}★` },
                    { etiqueta: "Toque → reseña", propio: radar.conversion.propio, sector: radar.conversion.sector, fmt: (v) => `${Math.round(v * 100)}%` },
                    { etiqueta: "Quejas resueltas", propio: radar.resolucion.propio, sector: radar.resolucion.sector, fmt: (v) => `${Math.round(v * 100)}%` },
                  ].map((fila) => {
                    if (fila.propio === null || fila.sector === null) {
                      return `<div class="radar-fila">
                        <div class="radar-etiqueta">${fila.etiqueta}</div>
                        <div class="radar-sin-dato">Todavía no hay suficientes datos tuyos para este cruce.</div>
                      </div>`;
                    }
                    const mejor = fila.propio >= fila.sector;
                    return `<div class="radar-fila">
                      <div class="radar-etiqueta">${fila.etiqueta}</div>
                      <div class="radar-valores">
                        <span class="radar-propio">Tú: <b>${fila.fmt(fila.propio)}</b></span>
                        <span class="radar-vs" style="color:${mejor ? MARCA.verde : MARCA.rojo};">${mejor ? "▲" : "▼"}</span>
                        <span class="radar-sectorval">Sector: <b>${fila.fmt(fila.sector)}</b></span>
                      </div>
                    </div>`;
                  }).join("")}
                </div>` : `<div class="sentimiento-vacio">Todavía no hay suficientes negocios parecidos en tu categoría para comparar.</div>`}
              </div>
            </div>
            ` : `
            <div class="panel-analitica-full">
              <div class="card-titulo">Cómo te calificaron</div>
              <div class="chart-card" style="margin-top:0;">
                ${totalCalificado > 0
                  ? `<div class="sentimiento-barra">
                       <div style="width:${pctPositivas}%;background:${MARCA.verde};"></div>
                       <div style="width:${pctNegativas}%;background:${MARCA.rojo};"></div>
                     </div>
                     <div class="sentimiento-leyenda">
                       <span><i style="background:${MARCA.verde};"></i>Positivas: ${testimonios.length} (${pctPositivas}%)</span>
                       <span><i style="background:${MARCA.rojo};"></i>Quejas: ${quejas.length} (${pctNegativas}%)</span>
                     </div>
                     ${tasaRecuperacion !== null ? `<div class="horas-nota">Tasa de recuperación: <b>${tasaRecuperacion}%</b> de las quejas resueltas</div>` : ""}`
                  : `<div class="sentimiento-vacio">Todavía no hay calificaciones registradas.</div>`}
              </div>
            </div>
            ${esPro(negocio) ? `
            <div class="panel-analitica-full">
              <div class="card-titulo">Tú vs. tu sector</div>
              <div class="chart-card" style="margin-top:0;">
                <div class="sentimiento-vacio">Vas a poder comparar tu negocio con los de tu categoría en cuanto haya al menos 2 negocios más como el tuyo en Tapin. Por ahora no hay suficientes para hacerlo sin señalar a nadie en particular.</div>
              </div>
            </div>
            ` : ""}
            `}

            <div class="panel-analitica-full">
              <div class="card-titulo">
                <span>Actividad reciente</span>
              </div>
              <div class="chart-card actividad-lista" style="margin-top:0;">
                ${actividadReciente || `<div style="text-align:center;color:${MARCA.textoSuave};padding:22px 0;">Sin toques todavía</div>`}
              </div>
            </div>
          </div>

          <div class="seccion grid-2 analitica-reputacion">
            <div>
              <div class="card-titulo">Más de tu plan Pro</div>
              <div class="reco" style="border-left-color:${MARCA.verde};">
                <b>Alertas instantáneas activas</b> — te llega un correo a <b>${negocio.email || "tu correo"}</b> apenas alguien deja una queja privada.
              </div>
              <div class="reco" style="border-left-color:${MARCA.verde};">
                <b>Reporte PDF mensual</b> — a fin de mes te llega por correo el análisis completo de tu negocio, automáticamente.
              </div>
              <div class="fila-herramientas">
                <a href="/quejas/${slug}?key=${claveUsada}" class="btn-herramienta">Retroalimentación privada</a>
                <a href="/reportes-guardados/${slug}?key=${claveUsada}" class="btn-herramienta">Reportes guardados</a>
              </div>
            </div>
            <div>
              <div class="card-titulo">Recomendaciones para ti</div>
              ${recomendacionesHtml}
            </div>
          </div>
          ` : `
          <div class="seccion">
            <div class="seccion-header">
              <div class="eyebrow">Plan Básico</div>
              <h2>Mejora a Pro y desbloquea todo esto</h2>
              <p>${horas.totalMes > 0
                ? `Con Pro verías, por ejemplo, que tu hora pico real es <b>${horas.picoHora}:00</b> — información que hoy tenemos calculada pero no te podemos mostrar.`
                : `Tu plan actual muestra lo esencial. Con Pro tienes mucho más detalle para tomar decisiones.`}</p>
            </div>
            <div class="chart-card" style="opacity:0.55;filter:grayscale(0.4);pointer-events:none;">
              <div class="horas-chart">${barraHoras(horas.porHora, horas.picoHora)}</div>
              <div class="horas-labels"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>
              <div class="horas-nota">Tus horas pico — bloqueado en el plan Básico.</div>
            </div>
            <div class="chart-card" style="opacity:0.55;filter:grayscale(0.4);pointer-events:none;margin-top:10px;">
              ${totalCalificado > 0
                ? `<div class="sentimiento-barra">
                     <div style="width:${pctPositivas}%;background:${MARCA.verde};"></div>
                     <div style="width:${pctNegativas}%;background:${MARCA.rojo};"></div>
                   </div>
                   <div class="sentimiento-leyenda">
                     <span><i style="background:${MARCA.verde};"></i>Positivas: ${testimonios.length} (${pctPositivas}%)</span>
                     <span><i style="background:${MARCA.rojo};"></i>Quejas: ${quejas.length} (${pctNegativas}%)</span>
                   </div>`
                : `<div class="sentimiento-vacio">Todavía no hay calificaciones registradas.</div>`}
              <div class="horas-nota">Cómo te calificaron — bloqueado en el plan Básico.</div>
            </div>
            <div class="reco" style="border-left-color:${MARCA.oro};background:#FBF6E9;color:#7A5A00;">
              Con <b>Plan Pro</b> ($${PRECIO_PRO_COP.toLocaleString("es-CO")} COP/mes) obtienes:
              <ul style="margin:8px 0 0;padding-left:18px;">
                <li>Gráfica de horas pico (cuándo te tocan más)</li>
                <li>Desglose de reputación: positivas vs. quejas privadas</li>
                <li>Tabla de actividad reciente con cada toque</li>
                <li>Recomendaciones automáticas para tu negocio</li>
                <li>Alertas instantáneas de quejas y reporte PDF mensual por correo</li>
                <li>Comparación con tu sector</li>
              </ul>
            </div>
            <div style="text-align:center;margin-top:18px;">
              <a href="/mejorar-a-pro/${slug}?key=${claveUsada}"
                 style="display:inline-block;background:${MARCA.verde};color:#fff;text-decoration:none;
                        padding:13px 26px;border-radius:10px;font-weight:700;font-size:0.9rem;">
                Pagar y activar Plan Pro
              </a>
              <div style="margin-top:10px;font-size:0.78rem;color:${MARCA.textoSuave};">
                $${PRECIO_PRO_COP.toLocaleString("es-CO")} COP/mes · se activa al instante
              </div>
            </div>
          </div>
          `}

        </div>
          </main>
        </div>
      </body>
    </html>
  `);
});


// ---------- Autogestión del negocio (sin necesitar al admin) ----------

// El negocio edita sus propios datos básicos (no el plan ni el código —
// eso lo sigue controlando Tapin desde /editar).
app.get("/mi-panel/:slug/editar", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  const claveUsada = claveEfectiva(req, slug);
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, claveUsada)) {
    return res.status(401).send("No autorizado.");
  }

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Editar negocio — ${negocio.nombre}</title>
        <style>
          ${ESTILO_BASE}
          .form-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:16px;padding:28px;max-width:480px;
                     box-shadow:0 8px 24px rgba(11,61,44,0.06);}
          label{font-size:0.82rem;font-weight:600;color:${MARCA.textoSuave};display:block;margin:14px 0 6px;}
          label:first-of-type{margin-top:0;}
          input,select{width:100%;padding:11px 13px;border:1px solid ${MARCA.borde};border-radius:9px;font-size:0.92rem;font-family:inherit;box-sizing:border-box;}
          button{margin-top:22px;width:100%;background:${MARCA.verdeOscuro};color:#fff;border:none;border-radius:9px;
                 padding:13px;font-size:0.95rem;font-weight:700;cursor:pointer;}
          .volver{display:inline-block;margin-top:14px;font-size:0.82rem;color:${MARCA.textoSuave};}
        </style>
      </head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div></div>
        <div class="content">
          <div class="eyebrow">Tu negocio</div>
          <h1 class="titulo-pagina">Editar información</h1>
          <div class="form-card">
            <form method="POST" action="/mi-panel/${slug}/editar?key=${claveUsada}">
              <label>Nombre del negocio</label>
              <input type="text" name="nombre" required value="${negocio.nombre || ""}">

              <label>Enlace de reseñas de Google</label>
              <input type="url" name="googleUrl" required value="${negocio.googleUrl || ""}">

              <label>Email (alertas y reportes)</label>
              <input type="email" name="email" required value="${negocio.email || ""}">

              <label>Dirección</label>
              <input type="text" name="direccion" value="${negocio.direccion || ""}">

              <label>Ciudad</label>
              <input type="text" name="ciudad" value="${negocio.ciudad || ""}">

              <label>Categoría</label>
              <select name="categoria">
                ${["restaurante", "peluqueria", "tienda", "clinica", "otro"]
                  .map((c) => `<option value="${c}" ${negocio.categoria === c ? "selected" : ""}>${c.charAt(0).toUpperCase() + c.slice(1)}</option>`)
                  .join("")}
              </select>

              <button type="submit">Guardar cambios</button>
            </form>
          </div>
          <a class="volver" href="/mi-panel/${slug}?key=${claveUsada}">&larr; Volver a mi panel</a>
        </div>
      </body>
    </html>
  `);
});

app.post("/mi-panel/:slug/editar", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) {
    return res.status(401).send("No autorizado.");
  }
  const { nombre, googleUrl, email, direccion, ciudad, categoria } = req.body;
  if (!nombre || !googleUrl || !email) {
    return res.status(400).send("Nombre, enlace de Google y correo son obligatorios.");
  }
  if (!esLinkGoogleValido(googleUrl)) {
    return res.status(400).send(
      "Ese enlace no sirve para reseñas — debe ser el link de \"Pedir reseñas\" de Google (empieza por " +
      "https://g.page/r/.../review), NO el enlace de \"Compartir\" de Google Maps. Verifica el link e " +
      "inténtalo de nuevo."
    );
  }
  guardarCambiosNegocio(slug, negocio, { nombre, googleUrl, email, direccion, ciudad, categoria });
  res.redirect(`/mi-panel/${slug}?key=${req.query.key}`);
});

// El negocio cambia su propia clave de acceso (por si la olvidan, la
// comparten de más, o simplemente quieren una nueva). Pide la clave actual
// para poder cambiarla — como cualquier cambio de contraseña normal.
app.get("/mi-panel/:slug/clave", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return enviarError(res, 404, "No encontramos este negocio", "Revisa que el enlace esté completo y bien escrito.");
  const claveUsada = claveEfectiva(req, slug);
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, claveUsada)) {
    return enviarError(res, 401, "No pudimos verificar tu acceso", "El enlace debe incluir tu clave personal (?key=...).");
  }

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Cambiar clave — ${negocio.nombre}</title>
        <style>
          ${ESTILO_BASE}
          .form-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:16px;padding:28px;max-width:420px;
                     box-shadow:0 8px 24px rgba(11,61,44,0.06);}
          label{font-size:0.82rem;font-weight:600;color:${MARCA.textoSuave};display:block;margin:14px 0 6px;}
          label:first-of-type{margin-top:0;}
          input{width:100%;padding:11px 13px;border:1px solid ${MARCA.borde};border-radius:9px;font-size:0.92rem;font-family:inherit;box-sizing:border-box;}
          button{margin-top:22px;width:100%;background:${MARCA.verdeOscuro};color:#fff;border:none;border-radius:9px;
                 padding:13px;font-size:0.95rem;font-weight:700;cursor:pointer;}
          .volver{display:inline-block;margin-top:14px;font-size:0.82rem;color:${MARCA.textoSuave};}
        </style>
      </head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div></div>
        <div class="content">
          <div class="eyebrow">Seguridad</div>
          <h1 class="titulo-pagina">Cambiar mi clave de acceso</h1>
          <div class="form-card">
            <form method="POST" action="/mi-panel/${slug}/clave?key=${claveUsada}">
              <label>Nueva clave (mínimo 6 caracteres)</label>
              <input type="text" name="claveNueva" required minlength="6">
              <button type="submit">Guardar nueva clave</button>
            </form>
          </div>
          <p style="font-size:0.78rem;color:${MARCA.textoSuave};max-width:420px;">
            Ojo: en cuanto la cambies, el link que tenías guardado con la clave vieja deja de funcionar —
            guarda el nuevo link que te va a salir aquí mismo.
          </p>
          <a class="volver" href="/mi-panel/${slug}?key=${claveUsada}">&larr; Volver a mi panel</a>
        </div>
        <script>${SCRIPT_ENVIO_FORMULARIO}</script>
      </body>
    </html>
  `);
});

app.post("/mi-panel/:slug/clave", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) {
    return res.status(401).send("No autorizado.");
  }
  const claveNueva = (req.body.claveNueva || "").trim();
  if (claveNueva.length < 6) {
    return res.status(400).send("La clave debe tener al menos 6 caracteres.");
  }
  const { salt: saltCambio, hash: hashCambio } = hashClaveNegocio(claveNueva);
  guardarCambiosNegocio(slug, negocio, { claveAccesoHash: hashCambio, claveAccesoSalt: saltCambio, claveAcceso: undefined });
  ponerCookieSesion(res, slug, claveNueva);
  registrarAuditoria(slug, negocio, "Cambiaste tu clave de acceso");

  res.send(`
    <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${ESTILO_BASE}
        .ok-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:16px;padding:28px;max-width:460px;}
        .ok-card code{background:${MARCA.verdeClaro};padding:3px 8px;border-radius:6px;word-break:break-all;}
      </style></head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div></div>
        <div class="content">
          <div class="eyebrow">Listo</div>
          <h1 class="titulo-pagina">Clave actualizada</h1>
          <div class="ok-card">
            <p>Guarda este link — es el nuevo acceso a tu panel:</p>
            <p><code>${req.protocol}://${req.get("host")}/mi-panel/${slug}?key=${claveNueva}</code></p>
          </div>
        </div>
      </body>
    </html>
  `);
});

// ---------- Configuración (ideas 3, 5, 12->no, 13, 14, 20, 22) ----------
// Un solo lugar para todos los ajustes, para no llenar el panel principal
// de botones — mantiene lo del día a día simple, y lo de configurar aparte.
app.get("/mi-panel/:slug/configuracion", (req, res) => {
  const slug = resolverSlug(req.params.slug);
  const negocio = obtenerNegocio(slug);
  if (!negocio) return enviarError(res, 404, "No encontramos este negocio", "Revisa que el enlace esté completo y bien escrito.");
  const claveUsada = claveEfectiva(req, slug);
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, claveUsada)) {
    return enviarError(res, 401, "No pudimos verificar tu acceso", "La configuración solo la puede abrir la clave completa del negocio, no un link de solo lectura.");
  }

  const alertas = negocio.alertas || { quejas: true, reporteMensual: true };
  const datos = leerDatos();
  const auditoria = ((datos[slug] && datos[slug].auditoria) || []).slice().reverse().slice(0, 15);
  const eventosParaTarjetas = (datos[slug] && datos[slug].eventos) || [];
  const resumenTarjetas = resumenPorTarjeta(slug, eventosParaTarjetas);

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Configuración — ${negocio.nombre}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          ${ESTILO_BASE}
          ${ESTILO_DASHBOARD}
          .content{max-width:640px;padding:0;}
          .config-seccion{margin-bottom:30px;}
          .config-seccion-titulo{font-size:0.72rem;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;
                                 color:${MARCA.textoSuave};margin:0 0 12px;padding-left:2px;}
          .form-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:10px;padding:20px 22px;margin-bottom:14px;}
          .form-card:last-child{margin-bottom:0;}
          .form-card h3{margin:0 0 4px;font-size:0.92rem;font-weight:700;}
          .form-card p.nota{color:${MARCA.textoSuave};font-size:0.78rem;margin:0 0 14px;line-height:1.5;}
          input[type=number], input[type=text]{width:100%;padding:11px 13px;border:1px solid ${MARCA.borde};border-radius:8px;
                font-size:0.92rem;box-sizing:border-box;margin-bottom:12px;font-family:inherit;}
          label{font-size:0.82rem;font-weight:600;color:${MARCA.textoSuave};display:block;margin-bottom:6px;}
          .fila-check{display:flex;align-items:center;gap:10px;margin-bottom:12px;cursor:pointer;}
          .fila-check input{width:auto;margin:0;}
          button{background:${MARCA.verdeOscuro};color:#fff;border:none;border-radius:8px;padding:11px 18px;font-weight:700;cursor:pointer;font-size:0.88rem;font-family:inherit;}
          button.secundario{background:#fff;color:${MARCA.texto};border:1px solid ${MARCA.borde};}
          button.peligro{background:#fff;color:${MARCA.rojo};border:1px solid #F0D0C8;}
          .codigo-caja{background:${MARCA.crema};border-radius:8px;padding:10px 12px;font-size:0.82rem;word-break:break-all;margin:10px 0;}
          .linea-audit{display:flex;justify-content:space-between;gap:10px;font-size:0.8rem;padding:9px 0;border-bottom:1px solid ${MARCA.borde};color:${MARCA.textoSuave};}
          .linea-audit:last-child{border-bottom:none;}
          .linea-audit b{color:${MARCA.texto};font-weight:600;}
        </style>
      </head>
      <body>
        <div class="dashboard-layout">
          <aside class="sidebar">
            <div class="sidebar-logo">${logoSvg("#FFFFFF", 26)}</div>
            <nav class="sidebar-nav">
              <a href="/mi-panel/${slug}?key=${claveUsada}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
                Resumen
              </a>
              <a href="/mi-panel/${slug}?key=${claveUsada}#actividad">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
                Actividad
              </a>
              <a href="${esPro(negocio) ? `/suscripcion/${slug}?key=${claveUsada}` : `/mejorar-a-pro/${slug}?key=${claveUsada}`}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                ${esPro(negocio) ? "Mi suscripción" : "Plan de pago"}
              </a>
              <a href="/mi-panel/${slug}/configuracion?key=${claveUsada}" class="activo">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>
                Configuración
              </a>
            </nav>
            <div class="sidebar-pie">
              <a href="/">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                Cerrar sesión
              </a>
            </div>
          </aside>
          <main class="dashboard-main">
        <div class="content" style="padding:0;max-width:640px;">

          <div class="dash-header">
            <div>
              <div class="eyebrow" style="margin-bottom:2px;">${escaparHtml(negocio.nombre)}</div>
              <h1>Configuración</h1>
            </div>
            <a href="/mi-panel/${slug}?key=${claveUsada}" class="dash-header-chip" style="text-decoration:none;">← Volver al panel</a>
          </div>

          ${esPro(negocio) ? `
          <div class="config-seccion">
            <div class="config-seccion-titulo">Cuenta y suscripción</div>
            <div class="form-card">
              <h3>Mi suscripción</h3>
              <p class="nota">Ver el estado de tu pago, cambiar de tarjeta, o cancelar el Plan Pro.</p>
              <a href="/suscripcion/${slug}?key=${claveUsada}" style="display:inline-block;background:${MARCA.verdeOscuro};color:#fff;
                 border-radius:8px;padding:11px 18px;font-weight:700;font-size:0.88rem;text-decoration:none;">
                Gestionar mi suscripción →
              </a>
            </div>
          </div>
          ` : ""}

          <div class="config-seccion">
            <div class="config-seccion-titulo">Objetivos del negocio</div>
            <div class="form-card">
              <h3>Meta mensual</h3>
              <p class="nota">Te ponemos una barra de progreso en el panel hacia esta meta.</p>
              <form method="POST" action="/mi-panel/${slug}/configuracion/meta?key=${claveUsada}">
                <label>¿Cuántos toques quieres este mes?</label>
                <input type="number" name="metaMensual" min="1" value="${negocio.metaMensual || ""}" placeholder="Ej: 150">
                <button type="submit">Guardar meta</button>
              </form>
            </div>
            <div class="form-card">
              <h3>Pausar negocio</h3>
              <p class="nota">${negocio.pausado
                ? "Tu negocio está pausado — no vamos a marcar caídas raras en tus estadísticas mientras tanto."
                : "Útil para vacaciones o remodelación, sin desactivar la tarjeta ni perder tu historial."}</p>
              <form method="POST" action="/mi-panel/${slug}/configuracion/pausar?key=${claveUsada}" ${negocio.pausado ? "" : `onsubmit="return confirm('¿Pausar ${escaparHtml(negocio.nombre)}? Mientras esté pausado, las calificaciones no se marcarán como caídas raras en tus estadísticas. Puedes reanudarlo cuando quieras.');"`}>
                <input type="hidden" name="pausar" value="${negocio.pausado ? "no" : "si"}">
                <button type="submit" class="${negocio.pausado ? "secundario" : "peligro"}">${negocio.pausado ? "Reanudar negocio" : "Pausar negocio"}</button>
              </form>
            </div>
          </div>

          ${esPro(negocio) ? `
          <div class="config-seccion">
            <div class="config-seccion-titulo">Notificaciones</div>
            <div class="form-card">
              <h3>Alertas por correo</h3>
              <p class="nota">Elige cuáles quieres recibir — todas están activadas por defecto.</p>
              <form method="POST" action="/mi-panel/${slug}/configuracion/alertas?key=${claveUsada}">
                <label class="fila-check"><input type="checkbox" name="quejas" ${alertas.quejas !== false ? "checked" : ""}> Avisarme cuando llega una queja</label>
                <label>¿Con qué frecuencia?</label>
                <select name="frecuenciaQuejas" style="width:100%;padding:11px 13px;border:1px solid ${MARCA.borde};border-radius:8px;font-size:0.92rem;box-sizing:border-box;margin-bottom:12px;font-family:inherit;">
                  <option value="instantanea" ${(alertas.frecuenciaQuejas || "instantanea") === "instantanea" ? "selected" : ""}>Al instante — apenas llega cada una</option>
                  <option value="diario" ${alertas.frecuenciaQuejas === "diario" ? "selected" : ""}>Resumen diario — un correo con todas las del día</option>
                  <option value="semanal" ${alertas.frecuenciaQuejas === "semanal" ? "selected" : ""}>Resumen semanal — un correo con todas de la semana</option>
                </select>
                <label class="fila-check"><input type="checkbox" name="reporteMensual" ${alertas.reporteMensual !== false ? "checked" : ""}> Reporte mensual automático</label>
                <label>WhatsApp para alertas (opcional)</label>
                <input type="text" name="whatsapp" value="${negocio.whatsappAlertas || ""}" placeholder="Ej: 3001234567">
                <p class="nota" style="margin:-6px 0 12px;">Por ahora solo guardamos el número — el envío automático por WhatsApp llega en una próxima actualización.</p>
                <button type="submit">Guardar preferencias</button>
              </form>
            </div>
          </div>
          ` : ""}

          <div class="config-seccion">
            <div class="config-seccion-titulo">Seguridad y acceso</div>
            <div class="form-card">
              <h3>Cambiar mi clave</h3>
              <p class="nota">Actualiza la clave con la que entras a este panel.</p>
              <a href="/mi-panel/${slug}/clave?key=${claveUsada}" style="display:inline-block;background:#fff;color:${MARCA.verdeOscuro};
                 border:1px solid ${MARCA.borde};border-radius:8px;padding:10px 16px;font-weight:700;font-size:0.85rem;text-decoration:none;">
                Cambiar mi clave →
              </a>
            </div>
            <div class="form-card">
              <h3>Acceso de solo lectura</h3>
              <p class="nota">Comparte este link con un encargado — puede ver el panel, pero no cambiar nada (ni clave, ni configuración, ni negocio).</p>
              ${negocio.claveSoloLectura
                ? `<div class="codigo-caja">${req.protocol}://${req.get("host")}/mi-panel/${slug}?key=${negocio.claveSoloLectura}</div>
                   <form method="POST" action="/mi-panel/${slug}/configuracion/solo-lectura?key=${claveUsada}" onsubmit="return confirm('¿Generar un nuevo link de solo lectura? El link anterior deja de funcionar de inmediato — si alguien lo tenía guardado, tendrás que compartirle el nuevo.');">
                     <button type="submit" class="secundario">Generar uno nuevo (invalida el anterior)</button>
                   </form>`
                : `<form method="POST" action="/mi-panel/${slug}/configuracion/solo-lectura?key=${claveUsada}">
                     <button type="submit">Generar acceso de solo lectura</button>
                   </form>`}
            </div>
          </div>

          <div class="config-seccion">
            <div class="config-seccion-titulo">Facturación</div>
            <div class="form-card">
              <h3>Datos para factura electrónica</h3>
              <p class="nota">Si dejas tu NIT aquí, generamos factura electrónica automática cada vez que se cobre tu Plan Pro (mejora o mensualidad). Déjalo vacío si no necesitas factura.</p>
              <form method="POST" action="/mi-panel/${slug}/configuracion/facturacion?key=${claveUsada}">
                <label>NIT o cédula</label>
                <input type="text" name="nit" value="${escaparHtml((negocio.datosFactura && negocio.datosFactura.nit) || "")}" placeholder="Ej: 900123456">
                <label>Razón social</label>
                <input type="text" name="razonSocial" value="${escaparHtml((negocio.datosFactura && negocio.datosFactura.razonSocial) || "")}" placeholder="Ej: Mi Negocio S.A.S.">
                <button type="submit">Guardar datos de facturación</button>
              </form>
            </div>
          </div>

          <div class="config-seccion">
            <div class="config-seccion-titulo">Tarjetas vinculadas</div>
            <div class="form-card">
              <h3>Tarjetas de este negocio</h3>
              <p class="nota">
                ¿Tienes más de una mesa, caja o entrada? Pide tarjetas Tapin adicionales y vincúlalas a este
                mismo negocio (no crean uno nuevo) — así les pones nombre y ves cuál recibe más toques.
              </p>
              <p class="nota" style="margin-bottom:6px;"><b>Identificador de este negocio</b> (pídelo al activar una tarjeta nueva, junto con tu clave de acceso):</p>
              <div class="codigo-caja">${slug}</div>

              <details style="margin-top:14px;">
                <summary style="cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;background:${MARCA.verde};color:#fff;border-radius:8px;padding:10px 16px;font-weight:700;font-size:0.8rem;">+ Agregar tarjeta</summary>
                <div style="margin-top:12px;padding:14px 16px;background:${MARCA.verdeClaro};border-radius:10px;font-size:0.82rem;line-height:1.55;">
                  <p style="margin:0 0 10px;">Escribe el código de la tarjeta física nueva (viene impreso o en el NFC) para vincularla a este negocio — empieza a sumar toques de inmediato, sin crear un negocio aparte.</p>
                  <form method="POST" action="/mi-panel/${slug}/configuracion/tarjetas/vincular?key=${claveUsada}" style="display:flex;gap:8px;flex-wrap:wrap;">
                    <input type="text" name="codigo" placeholder="Ej: ${slug}" required maxlength="20"
                           style="flex:1;min-width:180px;margin:0;padding:10px 12px;font-size:0.85rem;text-transform:uppercase;border:1px solid ${MARCA.borde};border-radius:8px;">
                    <button type="submit" style="margin:0;background:${MARCA.verde};color:#fff;border:none;padding:10px 16px;font-size:0.8rem;font-weight:700;border-radius:8px;">Vincular esta tarjeta</button>
                  </form>
                  <p style="margin:10px 0 0;color:${MARCA.textoSuave};">¿Es la primera tarjeta de un negocio nuevo (no de este)? Actívala normal desde la página de activación, eligiendo "Es un negocio nuevo". ¿No tienes tarjetas físicas adicionales todavía? Escríbeme para pedir más.</p>
                </div>
              </details>

              <div style="margin-top:16px;display:flex;flex-direction:column;gap:10px;">
                ${resumenTarjetas.map((t, i) => `
                  <div style="border:1px solid ${MARCA.borde};border-radius:10px;padding:12px 14px;">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
                      <div>
                        <div style="font-weight:700;font-size:0.88rem;">${escaparHtml(t.etiqueta || (t.esPrincipal ? "Tarjeta principal" : "Sin nombre"))}
                          ${i === 0 && resumenTarjetas.length > 1 && t.total > 0 ? `<span style="background:${MARCA.verdeClaro};color:${MARCA.verdeOscuro};font-size:0.66rem;font-weight:800;padding:2px 8px;border-radius:100px;margin-left:8px;vertical-align:middle;letter-spacing:0.03em;">MÁS ACTIVA</span>` : ""}
                        </div>
                        <code style="font-size:0.74rem;color:${MARCA.textoSuave};">${t.codigo}</code>
                      </div>
                      <div style="text-align:right;font-size:0.78rem;color:${MARCA.textoSuave};white-space:nowrap;">
                        <b style="color:${MARCA.texto};font-size:0.95rem;">${t.total}</b> toques totales<br>
                        ${t.hoy} hoy · ${t.semana} esta semana
                      </div>
                    </div>
                    <form method="POST" action="/mi-panel/${slug}/configuracion/tarjetas/${t.codigo}/nombre?key=${claveUsada}" style="display:flex;gap:8px;margin-top:10px;">
                      <input type="text" name="nombre" value="${escaparHtml(t.etiqueta || "")}" placeholder="Ej: Mesa 3, Caja, Entrada..." maxlength="40" style="flex:1;margin:0;padding:8px 10px;font-size:0.82rem;">
                      <button type="submit" class="secundario" style="margin:0;padding:8px 14px;font-size:0.78rem;">Guardar nombre</button>
                    </form>
                    ${t.codigo !== slug ? `
                    <form method="POST" action="/mi-panel/${slug}/configuracion/tarjetas/${t.codigo}/desvincular?key=${claveUsada}" style="margin-top:8px;" onsubmit="return confirm('¿Desvincular la tarjeta ${t.codigo}? Deja de sumar toques a este negocio y vuelve a quedar sin activar — se puede activar de nuevo después, como negocio nuevo o vinculada a otro.');">
                      <button type="submit" style="margin:0;background:#fff;color:${MARCA.rojo};border:1px solid #F0D0C8;padding:6px 12px;font-size:0.76rem;border-radius:7px;">Desvincular esta tarjeta</button>
                    </form>
                    ` : ""}
                  </div>
                `).join("")}
              </div>
            </div>
          </div>

          <div class="config-seccion">
            <div class="config-seccion-titulo">Actividad de la cuenta</div>
            <div class="form-card">
              <h3>Historial de cambios</h3>
              <p class="nota">Solo tuyo, para tener orden — no es visible para nadie más.</p>
              ${auditoria.length
                ? auditoria.map((a) => `<div class="linea-audit"><b>${a.texto}</b><span>${a.fechaLegible}</span></div>`).join("")
                : `<p class="nota" style="margin:0;">Todavía no hay cambios registrados.</p>`}
            </div>
          </div>

        </div>
          </main>
        </div>
        <script>${SCRIPT_ENVIO_FORMULARIO}</script>
      </body>
    </html>
  `);
});

app.post("/mi-panel/:slug/configuracion/meta", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) return res.status(401).send("No autorizado.");
  const metaMensual = parseInt(req.body.metaMensual, 10) || null;
  guardarCambiosNegocio(slug, negocio, { metaMensual });
  registrarAuditoria(slug, negocio, metaMensual ? `Configuraste una meta mensual de ${metaMensual} toques` : "Quitaste tu meta mensual");
  res.redirect(`/mi-panel/${slug}/configuracion?key=${req.query.key}`);
});

app.post("/mi-panel/:slug/configuracion/facturacion", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) return res.status(401).send("No autorizado.");
  const nit = (req.body.nit || "").trim();
  const razonSocial = (req.body.razonSocial || "").trim();
  guardarCambiosNegocio(slug, negocio, {
    datosFactura: nit ? { nit, razonSocial } : null,
  });
  registrarAuditoria(slug, negocio, nit ? "Actualizaste tus datos de facturación" : "Quitaste tus datos de facturación");
  res.redirect(`/mi-panel/${slug}/configuracion?key=${req.query.key}`);
});

app.post("/mi-panel/:slug/configuracion/alertas", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) return res.status(401).send("No autorizado.");
  const frecuenciaQuejas = ["instantanea", "diario", "semanal"].includes(req.body.frecuenciaQuejas)
    ? req.body.frecuenciaQuejas : "instantanea";
  const alertas = { quejas: req.body.quejas === "on", reporteMensual: req.body.reporteMensual === "on", frecuenciaQuejas };
  const whatsappAlertas = (req.body.whatsapp || "").trim();
  guardarCambiosNegocio(slug, negocio, { alertas, whatsappAlertas });
  res.redirect(`/mi-panel/${slug}/configuracion?key=${req.query.key}`);
});

app.post("/mi-panel/:slug/configuracion/pausar", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) return res.status(401).send("No autorizado.");
  const pausado = req.body.pausar === "si";
  guardarCambiosNegocio(slug, negocio, { pausado });
  registrarAuditoria(slug, negocio, pausado ? "Pausaste tu negocio" : "Reanudaste tu negocio");
  res.redirect(`/mi-panel/${slug}/configuracion?key=${req.query.key}`);
});

app.post("/mi-panel/:slug/configuracion/solo-lectura", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) return res.status(401).send("No autorizado.");
  const claveSoloLectura = generarToken();
  guardarCambiosNegocio(slug, negocio, { claveSoloLectura });
  registrarAuditoria(slug, negocio, "Generaste un nuevo acceso de solo lectura");
  res.redirect(`/mi-panel/${slug}/configuracion?key=${req.query.key}`);
});

// Ponerle nombre a una tarjeta física (la principal o una vinculada) — ej:
// "Mesa 3", "Caja", "Entrada" — para que el dueño identifique cuál es cuál
// en vez de tener que recordar códigos como "7K9P2M".
app.post("/mi-panel/:slug/configuracion/tarjetas/:codigo/nombre", (req, res) => {
  const { slug, codigo } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) return res.status(401).send("No autorizado.");

  const codigos = leerCodigos();
  // Solo se puede renombrar una tarjeta que de verdad es de este negocio —
  // o la principal (codigo === slug), o una vinculada a él.
  const esPropia = codigo === slug || (codigos[codigo] && codigos[codigo].vinculadoA === slug);
  if (!esPropia || !codigos[codigo]) {
    return res.status(404).send("Esa tarjeta no pertenece a este negocio.");
  }
  const nombreTarjeta = (req.body.nombre || "").trim().slice(0, 40);
  codigos[codigo].etiqueta = nombreTarjeta || null;
  guardarCodigos(codigos);
  registrarAuditoria(slug, negocio, nombreTarjeta ? `Renombraste la tarjeta ${codigo} a "${nombreTarjeta}"` : `Quitaste el nombre de la tarjeta ${codigo}`);
  res.redirect(`/mi-panel/${slug}/configuracion?key=${req.query.key}`);
});

// Vincula una tarjeta física nueva a este negocio directamente desde el
// propio panel del dueño, sin pasar por /activar/:codigo — el dueño solo
// escribe el código que trae la tarjeta nueva. Es el equivalente, en un solo
// paso y desde adentro del panel, al modo "vincular" que ya existe en la
// página pública de activación.
app.post("/mi-panel/:slug/configuracion/tarjetas/vincular", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) return res.status(401).send("No autorizado.");

  const volver = { texto: "Volver a Configuración", href: `/mi-panel/${slug}/configuracion?key=${req.query.key}` };
  const codigoInput = (req.body.codigo || "").trim().toUpperCase();
  if (!codigoInput) {
    return enviarError(res, 400, "Falta el código de la tarjeta", "Escribe el código que trae impreso o en el NFC la tarjeta física nueva.", volver);
  }

  const codigos = leerCodigos();
  const slugPrincipal = resolverSlug(codigoInput, codigos);
  if (slugPrincipal === slug || codigoInput === slug) {
    return enviarError(res, 400, "Esa tarjeta ya es de este negocio", "El código que escribiste ya pertenece a este negocio (es la tarjeta principal o ya está vinculada).", volver);
  }

  const entrada = codigos[codigoInput];
  if (!entrada) {
    return enviarError(res, 404, "No encontramos esa tarjeta", "Verifica que el código esté bien escrito — es el que viene impreso o en el NFC de la tarjeta física.", volver);
  }
  if (entrada.activado) {
    return enviarError(res, 400, "Esa tarjeta ya está en uso", "Esta tarjeta ya fue activada antes (es de otro negocio, o ya está vinculada a otro). Si es tuya y quieres moverla aquí, primero debe desvincularse desde el negocio donde está.", volver);
  }

  entrada.activado = true;
  entrada.activadoEl = new Date().toISOString();
  entrada.vinculadoA = slug;
  delete entrada.negocio;
  guardarCodigos(codigos);
  registrarAuditoria(slug, negocio, `Vinculaste la tarjeta ${codigoInput} a este negocio`);
  res.redirect(`/mi-panel/${slug}/configuracion?key=${req.query.key}`);
});

// Desvincula una tarjeta adicional del negocio -- versión para el propio
// dueño, con su clave normal (la versión de /editar/:slug es solo para
// administración con ADMIN_KEY). La tarjeta deja de sumar toques a este
// negocio y vuelve a quedar "sin activar", lista para activarse de nuevo
// (como negocio nuevo, o vinculada a otro).
app.post("/mi-panel/:slug/configuracion/tarjetas/:codigo/desvincular", (req, res) => {
  const { slug, codigo } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) return res.status(401).send("No autorizado.");

  if (codigo === slug) {
    return res.status(400).send("No puedes desvincular la tarjeta principal de un negocio.");
  }
  const codigos = leerCodigos();
  const entrada = codigos[codigo];
  if (!entrada || entrada.vinculadoA !== slug) {
    return res.status(404).send("Esa tarjeta no está vinculada a este negocio.");
  }
  codigos[codigo] = { creado: entrada.creado || new Date().toISOString() };
  guardarCodigos(codigos);
  registrarAuditoria(slug, negocio, `Desvinculaste la tarjeta ${codigo} de este negocio`);
  res.redirect(`/mi-panel/${slug}/configuracion?key=${req.query.key}`);
});



function normalizarIdentificador(valor) {
  return (valor || "").trim().toLowerCase();
}

// Suma un sello de fidelización — reutilizable desde cualquier punto donde
// identifiquemos al cliente (ya no depende de tocar una tarjeta física
// aparte; se dispara automáticamente al calificar con la tarjeta de reseñas).
function sumarSelloFidelizacion(slug, negocio, identificador, nombre) {
  const fid = negocio.fidelizacion;
  if (!fid) return null;
  const id = normalizarIdentificador(identificador);
  if (!id) return null;

  const datos = leerDatos();
  if (!datos[slug]) datos[slug] = { total: 0, eventos: [] };
  if (!datos[slug].fidelizacion) datos[slug].fidelizacion = {};
  const actual = datos[slug].fidelizacion[id] || { sellos: 0, nombre: nombre || id };
  actual.sellos = (actual.sellos || 0) + 1;
  if (nombre) actual.nombre = nombre;
  datos[slug].fidelizacion[id] = actual;
  guardarDatos(datos);

  return { actual, fid, listo: actual.sellos >= fid.metaSellos };
}

app.get("/mi-panel/:slug/fidelizacion", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  const claveUsada = claveEfectiva(req, slug);
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, claveUsada)) {
    return res.status(401).send("No autorizado.");
  }
  if (!esPro(negocio)) {
    return res.status(402).send(
      `La fidelización es exclusiva del Plan Pro. ` +
      `Súbele el plan a "${negocio.nombre}" desde /mejorar-a-pro/${slug}?key=${claveUsada} para activarla.`
    );
  }

  const fid = negocio.fidelizacion || { metaSellos: 10, premio: "" };
  const datos = leerDatos();
  const clientesFid = (datos[slug] && datos[slug].fidelizacion) || {};
  const totalClientes = Object.keys(clientesFid).length;
  const listosParaPremio = Object.values(clientesFid).filter((c) => c.sellos >= fid.metaSellos).length;

  const filas = Object.entries(clientesFid)
    .sort((a, b) => (b[1].sellos || 0) - (a[1].sellos || 0))
    .map(([id, c]) => {
      const listo = fid.metaSellos && c.sellos >= fid.metaSellos;
      return `<tr style="${listo ? `background:${MARCA.verdeClaro};` : ""}">
        <td>${escaparHtml(c.nombre || id)}</td>
        <td>${id}</td>
        <td>${c.sellos || 0} / ${fid.metaSellos || "—"}</td>
        <td>${listo
          ? `<a href="/mi-panel/${slug}/fidelizacion/${encodeURIComponent(id)}/canjear?key=${claveUsada}" style="color:${MARCA.verdeOscuro};font-weight:700;">Canjear premio</a>`
          : ""}</td>
      </tr>`;
    })
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Fidelización — ${negocio.nombre}</title>
        <style>
          ${ESTILO_BASE}
          table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden;border:1px solid ${MARCA.borde};margin-bottom:24px;}
          th,td{padding:10px 14px;text-align:left;border-bottom:1px solid ${MARCA.borde};font-size:0.85rem;}
          th{background:${MARCA.verdeOscuro};color:#fff;font-size:0.7rem;text-transform:uppercase;}
          a{color:${MARCA.verde};font-weight:600;text-decoration:none;font-size:0.82rem;}
          .form-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;padding:22px;max-width:420px;margin-bottom:24px;}
          input{width:100%;padding:11px 13px;border:1px solid ${MARCA.borde};border-radius:9px;font-size:0.92rem;box-sizing:border-box;margin-bottom:12px;}
          label{font-size:0.82rem;font-weight:600;color:${MARCA.textoSuave};display:block;margin-bottom:6px;}
          button{width:100%;background:${MARCA.verdeOscuro};color:#fff;border:none;border-radius:9px;padding:12px;font-weight:700;cursor:pointer;}
          .tarjeta-info{background:${MARCA.verdeClaro};border-radius:10px;padding:14px 16px;font-size:0.85rem;color:${MARCA.verdeOscuro};margin-bottom:24px;}
          .metrics{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap;}
          .metric{background:#fff;border:1px solid ${MARCA.borde};border-radius:12px;padding:14px 18px;flex:1;min-width:120px;text-align:center;}
          .metric-num{font-size:1.5rem;font-weight:800;color:${MARCA.verdeOscuro};}
          .metric-lbl{font-size:0.7rem;color:${MARCA.textoSuave};text-transform:uppercase;margin-top:2px;}
        </style>
      </head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div><a class="back" href="/mi-panel/${slug}?key=${claveUsada}" style="color:#CFE3D8;">&larr; Volver al panel</a></div>
        <div class="content">
          <div class="eyebrow">Plan Pro · ${negocio.nombre}</div>
          <h1 class="titulo-pagina">Fidelización</h1>
          <div class="subtitulo">Cada visita suma un sello. Tú decides cada cuántos y qué se ganan.</div>

          <div class="metrics">
            <div class="metric"><div class="metric-num">${totalClientes}</div><div class="metric-lbl">Clientes en el programa</div></div>
            <div class="metric"><div class="metric-num">${listosParaPremio}</div><div class="metric-lbl">Con premio listo</div></div>
          </div>

          <div class="tarjeta-info">
            No necesitas otra tarjeta — funciona con la misma tarjeta de reseñas. Cuando un cliente con cuenta en Tapin califica tu negocio (cualquier estrella), le suma un sello automáticamente.
          </div>

          <a href="/mi-panel/${slug}/fidelizacion/exportar.csv?key=${claveUsada}" style="display:inline-block;margin-bottom:22px;">Exportar clientes a CSV →</a>

          <div class="form-card">
            <h3 style="margin-top:0;">Configuración</h3>
            <form method="POST" action="/mi-panel/${slug}/fidelizacion?key=${claveUsada}">
              <label>¿Cada cuántos sellos se gana algo?</label>
              <input type="number" name="metaSellos" min="1" max="100" value="${fid.metaSellos || 10}" required>
              <label>¿Qué se gana? (se le muestra tal cual al cliente)</label>
              <input type="text" name="premio" value="${fid.premio || ""}" placeholder="Ej: Café gratis, 10% de descuento..." required>
              <button type="submit">Guardar</button>
            </form>
          </div>

          <table>
            <tr><th>Cliente</th><th>Identificador</th><th>Sellos</th><th>Acción</th></tr>
            ${filas || `<tr><td colspan="4">Todavía no hay clientes en el programa de fidelización.</td></tr>`}
          </table>
        </div>
      </body>
    </html>
  `);
});

app.post("/mi-panel/:slug/fidelizacion", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  const claveUsada = claveEfectiva(req, slug);
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, claveUsada)) {
    return res.status(401).send("No autorizado.");
  }
  if (!esPro(negocio)) return res.status(402).send("Exclusivo del Plan Pro.");

  const metaSellos = Math.min(100, Math.max(1, parseInt(req.body.metaSellos, 10) || 10));
  const premio = (req.body.premio || "").trim();
  if (!premio) return res.status(400).send("Falta describir el premio.");

  guardarCambiosNegocio(slug, negocio, { fidelizacion: { metaSellos, premio } });
  res.redirect(`/mi-panel/${slug}/fidelizacion?key=${claveUsada}`);
});

// Idea 2: exportar la lista de clientes de fidelización a CSV, para que el
// negocio les pueda escribir por su cuenta (WhatsApp, email marketing, etc.).
app.get("/mi-panel/:slug/fidelizacion/exportar.csv", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  const claveUsada = claveEfectiva(req, slug);
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, claveUsada)) {
    return res.status(401).send("No autorizado.");
  }
  const fid = negocio.fidelizacion || { metaSellos: 10 };
  const datos = leerDatos();
  const clientesFid = (datos[slug] && datos[slug].fidelizacion) || {};

  let csv = "Nombre,Identificador,Sellos,Meta,Premio disponible\n";
  for (const [id, c] of Object.entries(clientesFid)) {
    const listo = c.sellos >= fid.metaSellos ? "Sí" : "No";
    csv += `"${(c.nombre || id).replace(/"/g, '""')}","${id}",${c.sellos || 0},${fid.metaSellos},${listo}\n`;
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="fidelizacion-${slug}.csv"`);
  res.send("\uFEFF" + csv); // BOM para que Excel abra bien los acentos
});

app.get("/mi-panel/:slug/fidelizacion/:id/canjear", (req, res) => {
  const { slug, id } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  const claveUsada = claveEfectiva(req, slug);
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, claveUsada)) {
    return res.status(401).send("No autorizado.");
  }
  const datos = leerDatos();
  if (!datos[slug] || !datos[slug].fidelizacion || !datos[slug].fidelizacion[decodeURIComponent(id)]) {
    return res.status(404).send("Ese cliente no existe en el programa.");
  }
  datos[slug].fidelizacion[decodeURIComponent(id)].sellos = 0;
  guardarDatos(datos);
  res.redirect(`/mi-panel/${slug}/fidelizacion?key=${claveUsada}`);
});

app.get("/fidelidad/:slug", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!esPro(negocio) || !negocio.fidelizacion) {
    return res.status(402).send("Este negocio no tiene activa la fidelización todavía.");
  }

  const cliente = clienteActual(req);
  if (cliente) {
    return res.redirect(`/fidelidad/${slug}/sumar?id=${encodeURIComponent(normalizarIdentificador(cliente.email))}&nombre=${encodeURIComponent(cliente.nombre || "")}`);
  }

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:${MARCA.verdeOscuro};margin:0;
               min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
          .box{background:#fff;border-radius:18px;padding:32px 26px;max-width:360px;width:100%;text-align:center;}
          h1{font-size:1.15rem;color:${MARCA.texto};margin:14px 0 4px;}
          p{color:${MARCA.textoSuave};font-size:0.85rem;margin:0 0 20px;}
          input{width:100%;padding:13px;border:1px solid ${MARCA.borde};border-radius:9px;font-size:0.95rem;box-sizing:border-box;margin-bottom:12px;}
          button{width:100%;background:${MARCA.verdeOscuro};color:#fff;border:none;border-radius:9px;padding:13px;font-weight:700;cursor:pointer;}
          .divisor{font-size:0.76rem;color:#999;margin:16px 0;}
        </style>
      </head>
      <body>
        <div class="box">
          <div>${logoSvg(MARCA.verdeOscuro, 30)}</div>
          <h1>${negocio.nombre}</h1>
          <p>Escribe tu correo o celular para sumar tu sello de hoy</p>
          <form method="POST" action="/fidelidad/${slug}/identificar">
            <input type="text" name="identificador" required placeholder="Tu correo o celular">
            <input type="text" name="nombre" placeholder="Tu nombre (opcional)">
            <button type="submit">Sumar mi sello</button>
          </form>
          <div class="divisor">¿Ya tienes cuenta en Tapin? <a href="/cliente" style="color:${MARCA.verde};">Inicia sesión</a> y no tengas que escribir esto cada vez.</div>
        </div>
      </body>
    </html>
  `);
});

app.post("/fidelidad/:slug/identificar", (req, res) => {
  const { slug } = req.params;
  const identificador = normalizarIdentificador(req.body.identificador);
  if (!identificador) return res.status(400).send("Falta tu correo o celular.");
  res.redirect(`/fidelidad/${slug}/sumar?id=${encodeURIComponent(identificador)}&nombre=${encodeURIComponent(req.body.nombre || "")}`);
});

app.get("/fidelidad/:slug/sumar", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  const fid = negocio.fidelizacion;
  if (!esPro(negocio) || !fid) {
    return res.status(402).send("Este negocio no tiene activa la fidelización todavía.");
  }

  const id = normalizarIdentificador(req.query.id);
  if (!id) return res.status(400).send("Falta identificador.");
  const nombre = (req.query.nombre || "").trim();

  const datos = leerDatos();
  if (!datos[slug]) datos[slug] = { total: 0, eventos: [] };
  if (!datos[slug].fidelizacion) datos[slug].fidelizacion = {};
  const actual = datos[slug].fidelizacion[id] || { sellos: 0, nombre: nombre || id };
  actual.sellos = (actual.sellos || 0) + 1;
  if (nombre) actual.nombre = nombre;
  datos[slug].fidelizacion[id] = actual;
  guardarDatos(datos);

  const listo = actual.sellos >= fid.metaSellos;

  res.send(`
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body{font-family:-apple-system,sans-serif;background:${MARCA.verdeOscuro};display:flex;align-items:center;
      justify-content:center;min-height:100vh;margin:0;padding:24px;}
      .box{background:#fff;border-radius:18px;padding:36px 28px;max-width:360px;text-align:center;}
      .check{font-size:2.5rem;margin-bottom:10px;}
      .sellos{display:flex;justify-content:center;gap:6px;flex-wrap:wrap;margin:16px 0;}
      .sello{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;
             font-size:0.8rem;font-weight:700;}
      .sello.lleno{background:${MARCA.oro};color:#fff;}
      .sello.vacio{background:${MARCA.crema};color:${MARCA.textoSuave};border:1px solid ${MARCA.borde};}
    </style></head>
    <body><div class="box">
      <div class="check">${listo ? "🎉" : "✓"}</div>
      <h2>${listo ? "¡Premio desbloqueado!" : "¡Sello sumado!"}</h2>
      <div class="sellos">
        ${Array.from({ length: fid.metaSellos }, (_, i) =>
          `<div class="sello ${i < actual.sellos % fid.metaSellos || (listo && i < fid.metaSellos) ? "lleno" : "vacio"}">${i + 1}</div>`
        ).join("")}
      </div>
      <p style="color:${MARCA.textoSuave};">
        ${listo
          ? `Ya tienes: <b>${fid.premio}</b> — muéstrale esta pantalla al negocio.`
          : `Llevas <b>${actual.sellos} de ${fid.metaSellos}</b> — sigue así para ganar: ${fid.premio}`}
      </p>
      <a href="/cuenta" style="display:inline-block;margin-top:14px;color:${MARCA.verde};font-weight:700;font-size:0.85rem;">Ver todas mis fidelizaciones →</a>
    </div></body></html>
  `);
});

// Mismo reporte que el PDF, pero para ver directo en el navegador sin descargar nada.
// Visítalo así: https://tu-dominio.com/reporte/mi-negocio?key=TU_CLAVE
app.get("/reporte/:slug", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  const datos = leerDatos();
  const eventos = (datos[slug] && datos[slug].eventos) || [];
  const r = calcularResumen(eventos);
  const ultimoTexto = r.ultimo ? r.ultimo.fechaLegible : "Sin toques todavía";
  const recomendaciones = generarRecomendaciones(eventos, r, negocio);
  const recomendacionesHtml = recomendaciones.map((texto) => `<div class="reco">${texto}</div>`).join("");

  const recientes = eventos
    .slice(-20)
    .reverse()
    .map((e) => `<tr><td>${e.fechaLegible}</td><td>${e.dispositivo}</td></tr>`)
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Reporte — ${negocio.nombre}</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#F8F4EC;padding:28px 20px;color:#16201C;margin:0;}
          .back{color:#1F6E4E;font-weight:600;text-decoration:none;font-size:0.88rem;}
          .card{background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 10px rgba(0,0,0,0.05);
                border:1px solid #eee;max-width:520px;margin-top:16px;}
          h1{font-size:1.3rem;margin:0 0 2px;}
          .fecha{color:#999;font-size:0.8rem;margin-bottom:20px;}
          .metrics{display:flex;gap:14px;margin-bottom:18px;}
          .metric{background:#F8F4EC;border-radius:10px;padding:14px;flex:1;text-align:center;}
          .metric-num{font-size:1.5rem;font-weight:700;color:#1F6E4E;}
          .metric-lbl{font-size:0.72rem;color:#888;margin-top:4px;}
          .sparkline{display:flex;align-items:flex-end;gap:6px;height:90px;margin-bottom:20px;
                     border-top:1px solid #f0f0f0;padding-top:10px;}
          .reco{background:#F1F7F4;border-left:3px solid #1F6E4E;border-radius:8px;padding:12px 14px;
                font-size:0.85rem;margin-bottom:10px;color:#1F3D2E;}
          table{border-collapse:collapse;width:100%;margin-top:10px;}
          th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eee;font-size:0.85rem;}
          th{background:#16201C;color:#F8F4EC;}
        </style>
      </head>
      <body>
        <a class="back" href="/stats?key=${req.query.key}">&larr; Volver al panel</a>
        <div class="card">
          <h1>${negocio.nombre}</h1>
          <div class="fecha">Reporte generado el ${new Date().toLocaleDateString("es-CO", { timeZone: zonaDe(negocio) })}</div>
          <div class="metrics">
            <div class="metric"><div class="metric-num">${r.total}</div><div class="metric-lbl">Total</div></div>
            <div class="metric"><div class="metric-num">${r.hoy}</div><div class="metric-lbl">Hoy</div></div>
            <div class="metric"><div class="metric-num">${r.semana}</div><div class="metric-lbl">Últimos 7 días</div></div>
          </div>
          <div class="sparkline">${barraSemana(r.dias7)}</div>
          <div style="font-size:0.85rem;color:#666;margin-bottom:10px;">Último toque: <b>${ultimoTexto}</b></div>
          <h3 style="font-size:0.95rem;margin-bottom:10px;">Recomendaciones</h3>
          ${recomendacionesHtml}
          <h3 style="font-size:0.95rem;margin:18px 0 6px;">Últimas interacciones</h3>
          <table>
            <tr><th>Fecha y hora</th><th>Dispositivo</th></tr>
            ${recientes || "<tr><td colspan='2'>Sin toques todavía</td></tr>"}
          </table>
        </div>
      </body>
    </html>
  `);
});

// Reporte mensual en PDF, con diseño profesional de 3 páginas (portada, resumen
// ejecutivo con gráfica y recomendaciones, y detalle de interacciones) — pensado
// para entregar formalmente al cliente, no un volante de una sola hoja.
// Visítalo así: https://tu-dominio.com/export/mi-negocio.pdf?key=TU_CLAVE
app.get("/export/:slug.pdf", async (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!autorizadoProNegocio(req, negocio, slug)) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  // La exportación de reportes (CSV/PDF/Word) es exclusiva de Plan Pro.
  if (!esPro(negocio)) {
    return res.status(402).send(
      `La exportación de reportes es exclusiva del Plan Pro. ` +
      `Súbele el plan a "${negocio.nombre}" desde /editar/${slug}?key=${req.query.key} para activarla.`
    );
  }

  const pdfBytes = await generarInformePDF(negocio, slug);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="informe-tapin-${slug}.pdf"`);
  res.send(Buffer.from(pdfBytes));
});

// Genera el informe completo en PDF (4 páginas: portada, resumen ejecutivo,
// análisis por horas con picos/caídas, y detalle de interacciones). Reutilizado
// tanto por la descarga manual (/export/:slug.pdf) como por el correo mensual
// automático, para que el adjunto del correo sea el mismo informe completo.
async function generarInformePDF(negocio, slug) {
  const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

  const datos = leerDatos();
  const eventos = (datos[slug] && datos[slug].eventos) || [];
  const testimonios = (datos[slug] && datos[slug].testimonios) || [];
  const quejas = (datos[slug] && datos[slug].quejas) || [];
  const r = calcularResumen(eventos);
  const recomendaciones = generarRecomendaciones(eventos, r, negocio);
  const promSector = promedioSector(negocio.categoria, slug, datos);
  const horas = analizarHoras(eventos, negocio);
  const todosNegocios = todosLosNegocios();
  const percentil = percentilCategoria(negocio, slug, todosNegocios, datos);
  const diaFlojo = diaMasFlojo(eventos, negocio);
  const caidaPropia = !negocio.pausado ? alertaCaidaPropia(eventos, r.semana) : null;
  const clientesRecurrentes = contarClientesRecurrentes(slug);
  const comparativoMes = compararMesAnterior(eventos, negocio);
  const comparativoAnio = compararAnioAnterior(eventos, negocio);
  const calendario = calendarioMes(eventos, negocio);
  const proyeccion = proyeccionMes(eventos, negocio);
  const fechaGenerado = new Date().toLocaleDateString("es-CO", { timeZone: zonaDe(negocio), day: "numeric", month: "long", year: "numeric" });

  // ---------- Metricas estadísticas adicionales (analista de datos) ----------
  const totalCalificado = testimonios.length + quejas.length;
  const promedioEstrellas = promedioEstrellasFiltradas(testimonios, quejas);
  const pctPositivas = totalCalificado ? Math.round((testimonios.length / totalCalificado) * 100) : 0;
  const pctNegativas = totalCalificado ? 100 - pctPositivas : 0;
  const quejasResueltas = quejas.filter((q) => q.estado === "resuelto").length;
  const tasaRecuperacion = quejas.length ? Math.round((quejasResueltas / quejas.length) * 100) : null;

  const inicioHoyCmp = new Date();
  inicioHoyCmp.setHours(0, 0, 0, 0);
  const inicioSemanaAnteriorCmp = new Date(inicioHoyCmp);
  inicioSemanaAnteriorCmp.setDate(inicioSemanaAnteriorCmp.getDate() - 13);
  const finSemanaAnteriorCmp = new Date(inicioHoyCmp);
  finSemanaAnteriorCmp.setDate(finSemanaAnteriorCmp.getDate() - 6);
  const semanaAnteriorToques = eventos.filter((e) => {
    const f = new Date(e.fechaISO);
    return f >= inicioSemanaAnteriorCmp && f < finSemanaAnteriorCmp;
  }).length;
  const cambioSemanal = semanaAnteriorToques > 0 ? Math.round(((r.semana - semanaAnteriorToques) / semanaAnteriorToques) * 100) : null;

  const primerEvento = eventos.length ? new Date(eventos[0].fechaISO) : null;
  const diasActivo = primerEvento ? Math.max(1, Math.round((Date.now() - primerEvento.getTime()) / 86400000)) : 1;
  const promedioDiarioHistorico = Math.round((r.total / diasActivo) * 10) / 10;

  const nombresDiaCorto = ["Dom", "Lun", "Mar", "Mie", "Jue", "Vie", "Sab"];
  const mapaDiaSemana = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const porDiaSemana = new Array(7).fill(0);
  for (const e of eventos) {
    const corto = new Date(e.fechaISO).toLocaleString("en-US", { timeZone: zonaDe(negocio), weekday: "short" });
    porDiaSemana[mapaDiaSemana[corto]]++;
  }
  const totalDiaSemana = porDiaSemana.reduce((a, b) => a + b, 0);
  const diaMasFuerte = totalDiaSemana > 0
    ? nombresDiaCorto[porDiaSemana.indexOf(Math.max(...porDiaSemana))]
    : null;

  // Desglose por tipo de dispositivo -- dato que ya se capturaba en cada
  // toque pero nunca se analizaba en conjunto, solo se listaba toque por
  // toque en el anexo. Agregarlo dice algo real del negocio: si casi todo
  // es iPhone/Android, confirma que el toque NFC funciona bien desde
  // celular (lo esperado); si aparece mucho Windows/Mac/Desconocido, casi
  // siempre es personal probando la tarjeta desde un computador, no
  // clientes reales, y vale la pena que el negocio lo sepa.
  const conteoDispositivo = {};
  for (const e of eventos) {
    const d = e.dispositivo || "Desconocido";
    conteoDispositivo[d] = (conteoDispositivo[d] || 0) + 1;
  }
  const totalConDispositivo = eventos.length;
  const rankingDispositivo = Object.entries(conteoDispositivo).sort((a, b) => b[1] - a[1]);
  const toquesMovil = (conteoDispositivo["iPhone/iPad"] || 0) + (conteoDispositivo["Android"] || 0);
  const toquesSospechosos = totalConDispositivo - toquesMovil;
  const pctMovil = totalConDispositivo ? Math.round((toquesMovil / totalConDispositivo) * 100) : 0;
  const pctSospechoso = totalConDispositivo ? Math.round((toquesSospechosos / totalConDispositivo) * 100) : 0;

  const pdfDoc = await PDFDocument.create();
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const verdeOscuro = rgb(0.043, 0.239, 0.173);
  const verde = rgb(0.059, 0.318, 0.196);
  const verdeClaro = rgb(0.906, 0.941, 0.918);
  const oro = rgb(0.788, 0.635, 0.294);
  const oroClaro = rgb(0.984, 0.965, 0.910);
  const rojo = rgb(0.753, 0.224, 0.169);
  const rojoClaro = rgb(0.984, 0.937, 0.910);
  const crema = rgb(0.980, 0.980, 0.973);
  const oscuro = rgb(0.086, 0.125, 0.109);
  const gris = rgb(0.42, 0.46, 0.44);
  const grisClaro = rgb(0.85, 0.86, 0.83);
  const blanco = rgb(1, 1, 1);

  const ANCHO = 595, ALTO = 842;
  const MARGEN = 50;
  let numeroPagina = 0;

  function piePagina(page) {
    numeroPagina++;
    page.drawLine({ start: { x: MARGEN, y: 56 }, end: { x: ANCHO - MARGEN, y: 56 }, thickness: 0.5, color: verdeClaro });
    page.drawText("Tapin", { x: MARGEN, y: 38, size: 9, font: fontBold, color: verde });
    page.drawText("Informe analítico de desempeño - " + negocio.nombre, { x: 90, y: 38, size: 8, font, color: gris });
    page.drawText(String(numeroPagina), { x: ANCHO - 60, y: 38, size: 8, font, color: gris });
  }

  function encabezadoSeccion(page, titulo, subtitulo) {
    page.drawRectangle({ x: 0, y: ALTO - 70, width: ANCHO, height: 70, color: verdeOscuro });
    page.drawText(titulo, { x: MARGEN, y: ALTO - 44, size: 16, font: fontBold, color: blanco });
    page.drawText(subtitulo || negocio.nombre, { x: MARGEN, y: ALTO - 60, size: 9, font, color: rgb(0.81, 0.89, 0.85) });
  }

  function envolverTexto(fontObj, texto, size, maxWidth) {
    const palabras = String(texto).split(/\s+/).filter(Boolean);
    const lineas = [];
    let actual = "";
    for (const palabra of palabras) {
      const prueba = actual ? actual + " " + palabra : palabra;
      if (fontObj.widthOfTextAtSize(prueba, size) > maxWidth && actual) {
        lineas.push(actual);
        actual = palabra;
      } else {
        actual = prueba;
      }
    }
    if (actual) lineas.push(actual);
    return lineas;
  }

  function dibujarCaja(page, x, y, width, texto, opts) {
    opts = opts || {};
    const color = opts.color || verde;
    const fondo = opts.fondo || crema;
    const size = opts.size || 8.5;
    const fontObj = opts.fontObj || font;
    const lineHeight = opts.lineHeight || 11.5;
    const paddingV = opts.paddingV || 10;
    const paddingH = opts.paddingH || 13;
    const etiqueta = opts.etiqueta || null;
    const maxWidth = width - paddingH * 2;
    const lineas = envolverTexto(fontObj, texto, size, maxWidth);
    let alto = lineas.length * lineHeight + paddingV * 2;
    let offsetEtiqueta = 0;
    if (etiqueta) offsetEtiqueta = 12;
    alto += offsetEtiqueta;
    page.drawRectangle({ x, y: y - alto, width, height: alto, color: fondo });
    page.drawRectangle({ x, y: y - alto, width: 3, height: alto, color });
    let ly = y - paddingV - 7;
    if (etiqueta) {
      page.drawText(etiqueta.toUpperCase(), { x: x + paddingH, y: ly, size: 6.8, font: fontBold, color });
      ly -= offsetEtiqueta;
    }
    lineas.forEach((linea) => {
      page.drawText(linea, { x: x + paddingH, y: ly, size, font: fontObj, color: oscuro });
      ly -= lineHeight;
    });
    return alto;
  }

  function dibujarKpi(page, x, y, width, height, label, valor, opts) {
    opts = opts || {};
    const sub = opts.sub || null;
    const delta = opts.delta === undefined ? null : opts.delta;
    const color = opts.color || verde;
    page.drawRectangle({ x, y: y - height, width, height, color: crema });
    page.drawRectangle({ x, y: y - height, width: 4, height, color });
    page.drawText(String(valor), { x: x + 16, y: y - 30, size: 21, font: fontBold, color });
    page.drawText(label, { x: x + 16, y: y - 46, size: 8, font, color: gris });
    if (sub) page.drawText(sub, { x: x + 16, y: y - 58, size: 7.5, font, color: gris });
    if (delta !== null) {
      const positivo = delta >= 0;
      const texto = (positivo ? "+" : "") + delta + "%";
      // Nada de flechas ▲/▼ aqui -- la fuente estandar de pdf-lib (WinAnsi)
      // no las puede codificar y hacia fallar la generacion del PDF entero
      // (bug real, no relacionado con lo que se pidio, encontrado al
      // probar el informe). El signo +/- y el color ya distinguen subida/bajada.
      page.drawText(texto, { x: x + 16, y: y - 58, size: 8, font: fontBold, color: positivo ? verde : rojo });
    }
  }

  function dibujarBarras(page, x, yTop, width, alturaGrafico, valores, etiquetas, opts) {
    opts = opts || {};
    const colorBase = opts.colorBase || verde;
    const colorPico = opts.colorPico || oro;
    const indicePico = opts.indicePico === undefined ? null : opts.indicePico;
    const mostrarValor = opts.mostrarValor === undefined ? true : opts.mostrarValor;
    const tamEtiqueta = opts.tamEtiqueta || 8;
    const max = Math.max(1, ...valores);
    const anchoBarra = width / valores.length;
    valores.forEach((v, i) => {
      const alturaBarra = (v / max) * alturaGrafico;
      const bx = x + i * anchoBarra;
      const color = i === indicePico ? colorPico : colorBase;
      page.drawRectangle({ x: bx + anchoBarra * 0.15, y: yTop - alturaGrafico, width: anchoBarra * 0.7, height: alturaBarra || 1, color });
      if (mostrarValor) {
        page.drawText(String(v), { x: bx + anchoBarra * 0.5 - 5, y: yTop - alturaGrafico + (alturaBarra || 1) + 4, size: 7.5, font, color: gris });
      }
      if (etiquetas && etiquetas[i] !== undefined) {
        page.drawText(String(etiquetas[i]), { x: bx + anchoBarra * 0.5 - (String(etiquetas[i]).length * 2.6), y: yTop - alturaGrafico - 13, size: tamEtiqueta, font, color: oscuro });
      }
    });
    page.drawLine({ start: { x, y: yTop - alturaGrafico }, end: { x: x + width, y: yTop - alturaGrafico }, thickness: 0.5, color: grisClaro });
  }

  function dibujarGauge(page, x, y, width, pct, opts) {
    opts = opts || {};
    const alto = opts.alto || 10;
    const color = opts.color || verde;
    page.drawRectangle({ x, y, width, height: alto, color: grisClaro });
    page.drawRectangle({ x, y, width: (Math.max(0, Math.min(100, pct)) / 100) * width, height: alto, color });
  }

  function tituloSeccionInterna(page, texto, x, y) {
    page.drawText(texto, { x, y, size: 11, font: fontBold, color: oscuro });
  }

  const portada = pdfDoc.addPage([ANCHO, ALTO]);
  portada.drawRectangle({ x: 0, y: 0, width: ANCHO, height: ALTO, color: verdeOscuro });
  portada.drawRectangle({ x: 0, y: ALTO - 8, width: ANCHO, height: 8, color: oro });
  portada.drawText("TAPIN", { x: 50, y: ALTO - 120, size: 34, font: fontBold, color: blanco });
  portada.drawText("Informe analítico de desempeño", { x: 50, y: ALTO - 150, size: 14, font, color: rgb(0.81, 0.89, 0.85) });

  portada.drawLine({ start: { x: 50, y: ALTO - 200 }, end: { x: 250, y: ALTO - 200 }, thickness: 1.5, color: oro });
  portada.drawText(negocio.nombre, { x: 50, y: ALTO - 240, size: 26, font: fontBold, color: blanco });
  portada.drawText("Categoría: " + (negocio.categoria || "-"), { x: 50, y: ALTO - 264, size: 11, font, color: rgb(0.81, 0.89, 0.85) });
  portada.drawText("Generado el " + fechaGenerado, { x: 50, y: ALTO - 282, size: 11, font, color: rgb(0.81, 0.89, 0.85) });

  const fichaTecnica = [
    ["Interacciones analizadas", String(r.total)],
    ["Días con historial", String(diasActivo)],
    ["Calificaciones recibidas", String(totalCalificado)],
    ["Cobertura horaria (30 días)", horas.horasConDatos + "/24 horas"],
  ];
  let fy = ALTO - 340;
  portada.drawText("Ficha técnica del informe", { x: 50, y: fy, size: 9.5, font: fontBold, color: oro });
  fy -= 18;
  fichaTecnica.forEach((par) => {
    portada.drawText(par[0], { x: 50, y: fy, size: 9, font, color: rgb(0.81, 0.89, 0.85) });
    portada.drawText(par[1], { x: 300, y: fy, size: 9, font: fontBold, color: blanco });
    fy -= 16;
  });

  portada.drawRectangle({ x: 50, y: 120, width: ANCHO - 100, height: 1, color: rgb(0.3, 0.45, 0.38) });
  portada.drawText(
    "Preparado automáticamente a partir de la actividad real registrada en la tarjeta Tapin de este negocio. " +
    "Incluye análisis de tendencia, estacionalidad horaria y semanal, reputación y comparación sectorial.",
    { x: 50, y: 95, size: 9, font, color: rgb(0.7, 0.8, 0.75), maxWidth: ANCHO - 100, lineHeight: 13 }
  );
  portada.drawText("Tapin", { x: 50, y: 50, size: 9, font: fontBold, color: oro });

  const resumen = pdfDoc.addPage([ANCHO, ALTO]);
  encabezadoSeccion(resumen, "Resumen ejecutivo");

  let y = ALTO - 106;
  tituloSeccionInterna(resumen, "Métricas clave", MARGEN, y);
  y -= 18;

  const kpiW = (ANCHO - 100 - 3 * 12) / 4;
  const kpis = [
    ["Total histórico", r.total, null, null],
    ["Hoy", r.hoy, null, null],
    ["Últimos 7 días", r.semana, null, cambioSemanal],
    ["Promedio diario", promedioDiarioHistorico, "toques/día histórico", null],
  ];
  let kx = MARGEN;
  kpis.forEach((k) => {
    dibujarKpi(resumen, kx, y, kpiW, 64, k[0], k[1], { sub: k[2], delta: k[3], color: verde });
    kx += kpiW + 12;
  });
  y -= 84;

  const piezasResumen = [];
  if (cambioSemanal !== null) {
    piezasResumen.push(
      cambioSemanal >= 0
        ? "la actividad subio " + cambioSemanal + "% esta semana frente a la anterior"
        : "la actividad bajo " + Math.abs(cambioSemanal) + "% esta semana frente a la anterior"
    );
  }
  if (percentil !== null) piezasResumen.push("el negocio se ubica en el percentil " + percentil + " de su categoría");
  if (promedioEstrellas !== null) piezasResumen.push("el promedio de calificación filtrada es " + promedioEstrellas + "/5");
  const fraseResumen = piezasResumen.length
    ? "En síntesis: " + piezasResumen.join("; ") + "."
    : "Todavía no hay suficiente historial para generar una síntesis estadística confiable - vuelve a revisar este informe cuando haya más actividad acumulada.";

  y -= dibujarCaja(resumen, MARGEN, y, ANCHO - 100, fraseResumen, {
    color: verde, fondo: verdeClaro, size: 9, etiqueta: "Lectura del periodo",
  });
  y -= 18;

  tituloSeccionInterna(resumen, "Toques por día - últimos 7 días", MARGEN, y);
  y -= 14;
  const nombresDias7 = [];
  const ahoraD = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(ahoraD);
    d.setDate(d.getDate() - i);
    nombresDias7.push(d.toLocaleDateString("es-CO", { weekday: "short", timeZone: zonaDe(negocio) }));
  }
  dibujarBarras(resumen, MARGEN, y, ANCHO - 100, 92, r.dias7, nombresDias7, { indicePico: r.dias7.indexOf(Math.max(...r.dias7)) });
  y -= 92 + 34;

  if (comparativoMes.disponible) {
    tituloSeccionInterna(resumen, "Este mes vs. el anterior", MARGEN, y);
    y -= 16;
    const compW = (ANCHO - 100 - 2 * 12) / 3;
    let cx = MARGEN;
    dibujarKpi(resumen, cx, y, compW, 54, "Este mes", comparativoMes.mesActual, { color: verde });
    cx += compW + 12;
    dibujarKpi(resumen, cx, y, compW, 54, "Mes anterior", comparativoMes.mesAnterior, { color: gris });
    cx += compW + 12;
    dibujarKpi(resumen, cx, y, compW, 54, "Cambio", (comparativoMes.cambioPct >= 0 ? "+" : "") + comparativoMes.cambioPct + "%", {
      color: comparativoMes.cambioPct >= 0 ? verde : rojo,
    });
    y -= 70;
  }
  piePagina(resumen);

  const pTendencia = pdfDoc.addPage([ANCHO, ALTO]);
  encabezadoSeccion(pTendencia, "Tendencia y proyección", negocio.nombre + " - basado en el ritmo real de actividad");

  y = ALTO - 108;
  tituloSeccionInterna(pTendencia, "Mapa de calor del mes en curso", MARGEN, y);
  y -= 16;
  {
    const cols = 7;
    const cellGap = 4;
    const cellSize = (ANCHO - 100 - cellGap * (cols - 1)) / cols;
    const diasSemanaLbl = ["Dom", "Lun", "Mar", "Mie", "Jue", "Vie", "Sab"];
    diasSemanaLbl.forEach((lbl, i) => {
      pTendencia.drawText(lbl, { x: MARGEN + i * (cellSize + cellGap) + cellSize / 2 - 8, y, size: 7, font, color: gris });
    });
    y -= 14;
    let col = calendario.primerDiaSemana;
    let fila = 0;
    let cy = y;
    calendario.dias.forEach((v, i) => {
      const intensidad = v === 0 ? 0 : Math.max(0.15, v / calendario.max);
      const cx2 = MARGEN + col * (cellSize + cellGap);
      const cyPos = cy - fila * (cellSize + cellGap);
      pTendencia.drawRectangle({
        x: cx2, y: cyPos - cellSize, width: cellSize, height: cellSize,
        color: v === 0 ? grisClaro : rgb(0.059 + (1 - intensidad) * 0.3, 0.318 + (1 - intensidad) * 0.3, 0.196 + (1 - intensidad) * 0.3),
      });
      pTendencia.drawText(String(i + 1), {
        x: cx2 + 4, y: cyPos - cellSize + 5, size: 6.5, font,
        color: intensidad > 0.5 ? blanco : oscuro,
      });
      col++;
      if (col >= cols) { col = 0; fila++; }
    });
    const filasTotales = Math.ceil((calendario.primerDiaSemana + calendario.dias.length) / cols);
    y = cy - filasTotales * (cellSize + cellGap) - 10;
    pTendencia.drawText("Mas oscuro = más interacciones ese día.", { x: MARGEN, y, size: 7.5, font: fontItalic, color: gris });
    y -= 26;
  }

  tituloSeccionInterna(pTendencia, "Proyección de cierre de mes", MARGEN, y);
  y -= 16;
  if (proyeccion.suficiente) {
    const projW = (ANCHO - 100 - 2 * 12) / 3;
    let px = MARGEN;
    dibujarKpi(pTendencia, px, y, projW, 58, "Acumulado del mes", proyeccion.toquesMes, { color: verde });
    px += projW + 12;
    dibujarKpi(pTendencia, px, y, projW, 58, "Proyección al cierre", proyeccion.proyectado, { sub: "rango " + proyeccion.minimo + "-" + proyeccion.maximo, color: oro });
    px += projW + 12;
    dibujarKpi(pTendencia, px, y, projW, 58, "Ritmo diario", proyeccion.promedio, { sub: proyeccion.restantes + " días restantes", color: verde });
    y -= 78;
  } else {
    y -= dibujarCaja(pTendencia, MARGEN, y, ANCHO - 100,
      "Todavía no hay suficientes días acumulados este mes para calcular una proyección confiable (se necesitan al menos 3 días con actividad).",
      { color: gris, fondo: crema, size: 8.5 });
    y -= 14;
  }

  if (comparativoAnio) {
    y -= dibujarCaja(pTendencia, MARGEN, y, ANCHO - 100,
      "Comparado con el mismo mes del año pasado (" + comparativoAnio.mesAnioPasado + " toques), este mes registra " + comparativoAnio.mesActual + " - un cambio de " + (comparativoAnio.cambioPct >= 0 ? "+" : "") + comparativoAnio.cambioPct + "% interanual.",
      { color: verde, fondo: verdeClaro, size: 8.5, etiqueta: "Comparación interanual" });
    y -= 14;
  }

  if (caidaPropia) {
    y -= dibujarCaja(pTendencia, MARGEN, y, ANCHO - 100,
      "La semana actual está " + caidaPropia.pctCaida + "% por debajo del promedio histórico del propio negocio (~" + caidaPropia.promedioSemanal + " toques/semana). Vale la pena revisar si algo cambio (ubicacion de la tarjeta, horario, personal).",
      { color: rojo, fondo: rojoClaro, size: 8.5, etiqueta: "Anomalía detectada" });
  }
  piePagina(pTendencia);

  const paginaHoras = pdfDoc.addPage([ANCHO, ALTO]);
  encabezadoSeccion(paginaHoras, "Patrones horarios", negocio.nombre + " - últimos 30 días");

  y = ALTO - 108;
  paginaHoras.drawText("Distribución de la actividad a lo largo del día", { x: MARGEN, y, size: 9, font, color: gris });
  y -= 24;

  const horaTexto = function (h) { return h + ":00-" + ((h + 1) % 24) + ":00"; };
  const pctPico = horas.totalMes > 0 ? Math.round((horas.maxToques / horas.totalMes) * 100) : 0;
  const kpiHorasW = (ANCHO - 100 - 2 * 12) / 3;
  let hx = MARGEN;
  dibujarKpi(paginaHoras, hx, y, kpiHorasW, 62, "Hora pico", horaTexto(horas.picoHora), { sub: horas.maxToques + " toques (" + pctPico + "% del total)", color: oro });
  hx += kpiHorasW + 12;
  dibujarKpi(paginaHoras, hx, y, kpiHorasW, 62, "Hora más floja", horas.horaCaida != null ? horaTexto(horas.horaCaida) : "-", { sub: horas.minToques + " toques", color: rojo });
  hx += kpiHorasW + 12;
  dibujarKpi(paginaHoras, hx, y, kpiHorasW, 62, "Cobertura horaria", horas.horasConDatos + "/24", { sub: "horas del día con al menos 1 toque", color: verde });
  y -= 86;

  if (horas.totalMes > 0) {
    let textoTendencia;
    if (horas.tendenciaPico > 0) {
      textoTendencia = "La hora pico (" + horaTexto(horas.picoHora) + ") tuvo " + horas.tendenciaPico + " toques más esta semana que la anterior - la concentración de actividad en ese horario está subiendo.";
    } else if (horas.tendenciaPico < 0) {
      textoTendencia = "La hora pico (" + horaTexto(horas.picoHora) + ") tuvo " + Math.abs(horas.tendenciaPico) + " toques menos esta semana que la anterior - vale la pena revisar qué cambió en ese horario.";
    } else {
      textoTendencia = "La hora pico (" + horaTexto(horas.picoHora) + ") se mantuvo estable esta semana comparada con la anterior.";
    }
    y -= dibujarCaja(paginaHoras, MARGEN, y, ANCHO - 100, textoTendencia, { color: verde, fondo: verdeClaro, size: 8.5, etiqueta: "Lectura de la tendencia horaria" });
    y -= 14;
  }

  tituloSeccionInterna(paginaHoras, "Toques por hora del día (0-23h)", MARGEN, y);
  y -= 14;

  if (horas.totalMes === 0) {
    paginaHoras.drawText("Todavía no hay suficientes datos este mes para este análisis.", { x: MARGEN, y: y - 20, size: 9, font, color: gris });
  } else {
    const graficoAltura = 160;
    const anchoBarra = (ANCHO - 100) / 24;
    horas.porHora.forEach((v, h) => {
      const alturaBarra = (v / Math.max(1, horas.maxToques)) * graficoAltura;
      const bx = MARGEN + h * anchoBarra;
      const esPico = h === horas.picoHora && v > 0;
      paginaHoras.drawRectangle({
        x: bx + 1, y: y - graficoAltura, width: anchoBarra - 2, height: alturaBarra || 0.5,
        color: esPico ? oro : verde,
      });
      if (h % 3 === 0) {
        paginaHoras.drawText(String(h), { x: bx + 1, y: y - graficoAltura - 12, size: 6.5, font, color: gris });
      }
    });
    paginaHoras.drawLine({ start: { x: MARGEN, y: y - graficoAltura }, end: { x: ANCHO - MARGEN, y: y - graficoAltura }, thickness: 0.5, color: grisClaro });
  }
  piePagina(paginaHoras);

  const pSemana = pdfDoc.addPage([ANCHO, ALTO]);
  encabezadoSeccion(pSemana, "Patrones semanales", negocio.nombre + " - historial completo");

  y = ALTO - 108;
  pSemana.drawText("Distribución histórica de la actividad por día de la semana", { x: MARGEN, y, size: 9, font, color: gris });
  y -= 26;

  if (totalDiaSemana > 0) {
    dibujarBarras(pSemana, MARGEN, y, ANCHO - 100, 140, porDiaSemana, nombresDiaCorto, {
      indicePico: porDiaSemana.indexOf(Math.max(...porDiaSemana)),
    });
    y -= 140 + 34;

    if (diaFlojo) {
      y -= dibujarCaja(pSemana, MARGEN, y, ANCHO - 100,
        "El " + diaFlojo.dia + " es historicamente el día con menos actividad (" + diaFlojo.toques + " toques acumulados). " + (diaMasFuerte ? "El día con mejor desempeño es " + diaMasFuerte + "." : "") + " Considera una promoción o recordatorio a clientes frecuentes ese día.",
        { color: oro, fondo: oroClaro, size: 8.5, etiqueta: "Estacionalidad semanal" });
      y -= 14;
    }
  } else {
    pSemana.drawText("Todavía no hay suficiente historial para identificar un patrón por día de la semana.", { x: MARGEN, y: y - 10, size: 9, font, color: gris });
    y -= 40;
  }

  tituloSeccionInterna(pSemana, "Clientes recurrentes", MARGEN, y);
  y -= 16;
  dibujarKpi(pSemana, MARGEN, y, (ANCHO - 100 - 12) / 2, 60, "Clientes con 3+ calificaciones", clientesRecurrentes, { sub: "señal de fidelización real, no solo tráfico nuevo", color: verde });
  y -= 80;
  piePagina(pSemana);

  const pReputacion = pdfDoc.addPage([ANCHO, ALTO]);
  encabezadoSeccion(pReputacion, "Reputación y satisfacción", negocio.nombre + " - calificaciones filtradas por Tapin");

  y = ALTO - 108;
  const repW = (ANCHO - 100 - 2 * 12) / 3;
  let rx = MARGEN;
  dibujarKpi(pReputacion, rx, y, repW, 62, "Calificación promedio", promedioEstrellas !== null ? promedioEstrellas + "/5" : "-", { sub: totalCalificado + " evaluaciones", color: oro });
  rx += repW + 12;
  dibujarKpi(pReputacion, rx, y, repW, 62, "Reseñas positivas", pctPositivas + "%", { sub: testimonios.length + " enviadas a Google", color: verde });
  rx += repW + 12;
  dibujarKpi(pReputacion, rx, y, repW, 62, "Quejas privadas", pctNegativas + "%", { sub: tasaRecuperacion !== null ? tasaRecuperacion + "% resueltas" : quejas.length + " recibidas", color: rojo });
  y -= 86;

  tituloSeccionInterna(pReputacion, "Distribución de calificaciones filtradas", MARGEN, y);
  y -= 16;
  if (totalCalificado > 0) {
    const barraAncho = ANCHO - 100;
    const wPos = (pctPositivas / 100) * barraAncho;
    pReputacion.drawRectangle({ x: MARGEN, y: y - 16, width: barraAncho, height: 16, color: rojoClaro });
    pReputacion.drawRectangle({ x: MARGEN, y: y - 16, width: wPos, height: 16, color: verde });
    y -= 30;
    pReputacion.drawRectangle({ x: MARGEN, y: y - 10, width: 9, height: 9, color: verde });
    pReputacion.drawText("Positivas - enviadas a Google (" + testimonios.length + ", " + pctPositivas + "%)", { x: MARGEN + 15, y: y - 9, size: 8.5, font, color: oscuro });
    y -= 16;
    pReputacion.drawRectangle({ x: MARGEN, y: y - 10, width: 9, height: 9, color: rojo });
    pReputacion.drawText("Quejas - privadas, nunca públicas (" + quejas.length + ", " + pctNegativas + "%)", { x: MARGEN + 15, y: y - 9, size: 8.5, font, color: oscuro });
    y -= 26;

    if (tasaRecuperacion !== null) {
      y -= dibujarCaja(pReputacion, MARGEN, y, ANCHO - 100,
        "De las " + quejas.length + " quejas privadas recibidas, " + quejasResueltas + " ya fueron marcadas como resueltas - una tasa de recuperación del " + tasaRecuperacion + "%. Cada queja resuelta es una reseña negativa pública que se evitó.",
        { color: verde, fondo: verdeClaro, size: 8.5, etiqueta: "Gestión de reputación" });
    }
  } else {
    pReputacion.drawText("Todavía no hay calificaciones registradas en este periodo.", { x: MARGEN, y: y - 10, size: 9, font, color: gris });
  }
  piePagina(pReputacion);

  const pSector = pdfDoc.addPage([ANCHO, ALTO]);
  encabezadoSeccion(pSector, "Comparación sectorial", negocio.nombre + " - categoría: " + (negocio.categoria || "-"));

  y = ALTO - 108;
  if (promSector !== null) {
    tituloSeccionInterna(pSector, "Toques de la última semana vs. el promedio del sector", MARGEN, y);
    y -= 20;
    const base = Math.max(1, r.semana, promSector);
    pSector.drawText("Tu", { x: MARGEN, y, size: 9, font: fontBold, color: oscuro });
    pSector.drawText(String(r.semana), { x: ANCHO - MARGEN - 24, y, size: 9, font: fontBold, color: verde });
    y -= 12;
    dibujarGauge(pSector, MARGEN, y - 10, ANCHO - 100, (r.semana / base) * 100, { color: verde });
    y -= 30;
    pSector.drawText("Promedio del sector", { x: MARGEN, y, size: 9, font: fontBold, color: oscuro });
    pSector.drawText(String(promSector), { x: ANCHO - MARGEN - 24, y, size: 9, font: fontBold, color: oro });
    y -= 12;
    dibujarGauge(pSector, MARGEN, y - 10, ANCHO - 100, (promSector / base) * 100, { color: oro });
    y -= 40;

    const diferenciaSector = r.semana - promSector;
    y -= dibujarCaja(pSector, MARGEN, y, ANCHO - 100,
      diferenciaSector >= 0
        ? "El negocio está " + diferenciaSector + " toques por encima del promedio de su categoría esta semana."
        : "El negocio está " + Math.abs(diferenciaSector) + " toques por debajo del promedio de su categoría esta semana - es la principal palanca de mejora a corto plazo.",
      { color: diferenciaSector >= 0 ? verde : rojo, fondo: diferenciaSector >= 0 ? verdeClaro : rojoClaro, size: 8.5, etiqueta: "Brecha vs. sector" });
    y -= 18;
  } else {
    y -= dibujarCaja(pSector, MARGEN, y, ANCHO - 100,
      "Todavía no hay suficientes negocios de la misma categoría y país en Tapin para calcular un promedio sectorial confiable.",
      { color: gris, fondo: crema, size: 8.5 });
    y -= 18;
  }

  if (percentil !== null) {
    tituloSeccionInterna(pSector, "Posición relativa dentro de la categoría", MARGEN, y);
    y -= 20;
    dibujarGauge(pSector, MARGEN, y - 10, ANCHO - 100, percentil, { color: verde, alto: 14 });
    pSector.drawText("Percentil " + percentil, { x: MARGEN, y: y - 30, size: 10, font: fontBold, color: verde });
    pSector.drawText(
      percentil >= 50
        ? "El negocio está en el " + (100 - percentil + 1) + "% superior de su categoría en toques de la última semana."
        : "El negocio está por debajo de la mediana de su categoría en toques de la última semana.",
      { x: MARGEN, y: y - 46, size: 8.5, font, color: gris, maxWidth: ANCHO - 100, lineHeight: 11 }
    );
    y -= 70;
  }
  piePagina(pSector);

  const pReco = pdfDoc.addPage([ANCHO, ALTO]);
  encabezadoSeccion(pReco, "Recomendaciones basadas en datos", negocio.nombre);

  y = ALTO - 108;
  pReco.drawText("Generadas automáticamente a partir de los patrones detectados en este informe.", { x: MARGEN, y, size: 9, font: fontItalic, color: gris });
  y -= 24;

  const todasLasRecos = recomendaciones.slice();
  if (diaFlojo) todasLasRecos.push("Refuerza la promoción o el personal el " + diaFlojo.dia + ", tu día historicamente más flojo.");
  if (caidaPropia) todasLasRecos.push("La semana actual está " + caidaPropia.pctCaida + "% por debajo de tu propio promedio - revisa si algo cambio operativamente.");
  if (percentil !== null && percentil < 50) todasLasRecos.push("Estas por debajo de la mediana de tu categoría - revisa la ubicacion de la tarjeta y la frecuencia con que el personal la ofrece.");
  if (tasaRecuperacion !== null && tasaRecuperacion < 50) todasLasRecos.push("Solo el " + tasaRecuperacion + "% de las quejas privadas están resueltas - cerrar ese ciclo mejora la retención de clientes insatisfechos.");

  todasLasRecos.forEach((texto) => {
    if (y < 100) return;
    y -= dibujarCaja(pReco, MARGEN, y, ANCHO - 100, texto, { color: oro, fondo: oroClaro, size: 8.8 });
    y -= 10;
  });
  piePagina(pReco);


  const detalle = pdfDoc.addPage([ANCHO, ALTO]);
  encabezadoSeccion(detalle, "Anexo - detalle de interacciones", negocio.nombre);

  y = ALTO - 110;
  detalle.drawText("Últimas interacciones registradas (max. 30)", { x: MARGEN, y, size: 11, font: fontBold, color: oscuro });
  y -= 22;

  detalle.drawRectangle({ x: MARGEN, y: y - 18, width: ANCHO - 100, height: 18, color: verdeOscuro });
  detalle.drawText("Fecha y hora", { x: 58, y: y - 13, size: 8.5, font: fontBold, color: blanco });
  detalle.drawText("Dispositivo", { x: 320, y: y - 13, size: 8.5, font: fontBold, color: blanco });
  y -= 18;

  const recientes = eventos.slice(-30).reverse();
  recientes.forEach((e, i) => {
    if (y < 90) return;
    if (i % 2 === 0) detalle.drawRectangle({ x: MARGEN, y: y - 16, width: ANCHO - 100, height: 16, color: crema });
    detalle.drawText(e.fechaLegible, { x: 58, y: y - 12, size: 8.5, font, color: oscuro });
    detalle.drawText(e.dispositivo, { x: 320, y: y - 12, size: 8.5, font, color: oscuro });
    y -= 16;
  });
  if (recientes.length === 0) {
    detalle.drawText("Sin interacciones registradas todavía.", { x: 58, y: y - 12, size: 9, font, color: gris });
    y -= 20;
  }

  y -= 24;
  if (y > 130) {
    detalle.drawText("Metodología", { x: MARGEN, y, size: 10, font: fontBold, color: oscuro });
    y -= 16;
    const notaMetodologica =
      "Todas las cifras de este informe provienen exclusivamente de los toques NFC y calificaciones registrados en la tarjeta Tapin de este negocio. " +
      "Las proyecciones se calculan a partir del ritmo diario observado en el periodo, con un rango de +-15% para reflejar la incertidumbre natural. " +
      "Los promedios y percentiles sectoriales solo se muestran cuando hay al menos 3 negocios comparables de la misma categoría y país. " +
      "Las calificaciones negativas nunca se publican en Google; se gestionan como retroalimentación privada.";
    detalle.drawText(notaMetodologica, { x: MARGEN, y, size: 7.8, font: fontItalic, color: gris, maxWidth: ANCHO - 100, lineHeight: 11 });
  }
  piePagina(detalle);

  return pdfDoc.save();
}

// Informe de entrega en Word (.docx) — editable, para que tú o el cliente lo
// personalicen, lo peguen en una propuesta, o lo usen como acta formal.
// Visítalo así: https://tu-dominio.com/export/mi-negocio.docx?key=TU_CLAVE
app.get("/export/:slug.docx", async (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!autorizadoProNegocio(req, negocio, slug)) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  if (!esPro(negocio)) {
    return res.status(402).send(
      `La exportación de reportes es exclusiva del Plan Pro. ` +
      `Súbele el plan a "${negocio.nombre}" desde /editar/${slug}?key=${req.query.key} para activarla.`
    );
  }

  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  } = require("docx");

  const datos = leerDatos();
  const eventos = (datos[slug] && datos[slug].eventos) || [];
  const r = calcularResumen(eventos);
  const recomendaciones = generarRecomendaciones(eventos, r, negocio);
  const promSector = promedioSector(negocio.categoria, slug, datos);
  const fechaGenerado = new Date().toLocaleDateString("es-CO", { timeZone: zonaDe(negocio), day: "numeric", month: "long", year: "numeric" });

  const VERDE = "0F5132";
  const ORO = "C9A24B";
  const GRIS = "6B726F";

  function celda(texto, opciones = {}) {
    return new TableCell({
      width: { size: opciones.width || 50, type: WidthType.PERCENTAGE },
      shading: opciones.fondo ? { type: ShadingType.CLEAR, fill: opciones.fondo } : undefined,
      children: [new Paragraph({
        children: [new TextRun({ text: texto, bold: !!opciones.bold, color: opciones.color || "16201C", size: opciones.size || 20 })],
      })],
    });
  }

  const tablaMetricas = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [
        celda("Métrica", { bold: true, fondo: VERDE, color: "FFFFFF" }),
        celda("Valor", { bold: true, fondo: VERDE, color: "FFFFFF" }),
      ]}),
      new TableRow({ children: [celda("Toques totales"), celda(String(r.total))] }),
      new TableRow({ children: [celda("Toques hoy"), celda(String(r.hoy))] }),
      new TableRow({ children: [celda("Últimos 7 días"), celda(String(r.semana))] }),
    ],
  });

  const filasInteracciones = eventos.slice(-20).reverse().map((e) =>
    new TableRow({ children: [celda(e.fechaLegible, { size: 18 }), celda(e.dispositivo, { size: 18 })] })
  );

  const tablaInteracciones = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [
        celda("Fecha y hora", { bold: true, fondo: "E7F0EA" }),
        celda("Dispositivo", { bold: true, fondo: "E7F0EA" }),
      ]}),
      ...filasInteracciones,
    ],
  });

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          children: [new TextRun({ text: "TAPIN", bold: true, size: 48, color: VERDE })],
        }),
        new Paragraph({
          children: [new TextRun({ text: "Informe de desempeño", size: 26, color: GRIS })],
          spacing: { after: 200 },
        }),
        new Paragraph({
          children: [new TextRun({ text: negocio.nombre, bold: true, size: 32 })],
        }),
        new Paragraph({
          children: [new TextRun({ text: `Categoría: ${negocio.categoria || "—"}  ·  Generado el ${fechaGenerado}`, size: 20, color: GRIS })],
          spacing: { after: 400 },
        }),

        new Paragraph({ text: "Resumen ejecutivo", heading: HeadingLevel.HEADING_1, spacing: { after: 200 } }),
        tablaMetricas,

        new Paragraph({ text: "", spacing: { after: 200 } }),
        ...(promSector !== null ? [
          new Paragraph({
            children: [new TextRun({
              text: r.semana >= promSector
                ? `Este negocio está por encima del promedio de su categoría (${r.semana} vs. ${promSector} toques/semana).`
                : `Este negocio está por debajo del promedio de su categoría (${r.semana} vs. ${promSector} toques/semana).`,
              italics: true, color: VERDE, size: 20,
            })],
            spacing: { after: 300 },
          }),
        ] : []),

        new Paragraph({ text: "Recomendaciones", heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 200 } }),
        ...recomendaciones.map((texto) => new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: texto, size: 20 })],
          spacing: { after: 100 },
        })),

        new Paragraph({ text: "Detalle de interacciones recientes", heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 200 } }),
        tablaInteracciones,

        new Paragraph({
          children: [new TextRun({ text: "Preparado automáticamente por Tapin a partir de la actividad real registrada en la tarjeta de este negocio.", italics: true, size: 16, color: GRIS })],
          spacing: { before: 400 },
        }),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="informe-tapin-${slug}.docx"`);
  res.send(buffer);
});

// Acta de entrega / certificado de instalación — documento formal de una página
// que respalda el cobro inicial y deja constancia de la fecha de activación
// y las condiciones del servicio. Útil como soporte comercial con el cliente.
// Visítalo así: https://tu-dominio.com/entrega/mi-negocio.pdf?key=TU_CLAVE
app.get("/entrega/:slug.pdf", limitarIntentosAdmin, async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

  const codigos = leerCodigos();
  const entrada = codigos[slug];
  const fechaActivacion = (entrada && entrada.activadoEl)
    ? new Date(entrada.activadoEl).toLocaleDateString("es-CO", { timeZone: zonaDe(negocio), day: "numeric", month: "long", year: "numeric" })
    : new Date().toLocaleDateString("es-CO", { timeZone: zonaDe(negocio), day: "numeric", month: "long", year: "numeric" });

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const verdeOscuro = rgb(0.043, 0.239, 0.173);
  const verde = rgb(0.059, 0.318, 0.196);
  const oro = rgb(0.788, 0.635, 0.294);
  const oscuro = rgb(0.086, 0.125, 0.109);
  const gris = rgb(0.42, 0.46, 0.44);
  const blanco = rgb(1, 1, 1);
  const crema = rgb(0.980, 0.980, 0.973);
  const ANCHO = 595, ALTO = 842;

  page.drawRectangle({ x: 0, y: ALTO - 90, width: ANCHO, height: 90, color: verdeOscuro });
  page.drawRectangle({ x: 0, y: ALTO - 90, width: ANCHO, height: 4, color: oro });
  page.drawText("TAPIN", { x: 50, y: ALTO - 45, size: 22, font: fontBold, color: blanco });
  page.drawText("Acta de entrega e instalación", { x: 50, y: ALTO - 68, size: 12, font, color: rgb(0.81, 0.89, 0.85) });

  let y = ALTO - 140;
  page.drawText("Datos del servicio", { x: 50, y, size: 12, font: fontBold, color: oscuro });
  y -= 24;

  const filas = [
    ["Negocio", negocio.nombre],
    ["Categoría", negocio.categoria || "—"],
    ["Fecha de activación", fechaActivacion],
    ["Enlace de reseñas configurado", "Sí"],
    ["Plan contratado", esPro(negocio) ? "Pro (mensual)" : "Básico (pago único)"],
    ["Código de tarjeta", slug],
  ];
  filas.forEach(([label, val], i) => {
    if (i % 2 === 0) page.drawRectangle({ x: 50, y: y - 20, width: ANCHO - 100, height: 20, color: crema });
    page.drawText(label, { x: 58, y: y - 15, size: 10, font: fontBold, color: oscuro });
    page.drawText(String(val), { x: 280, y: y - 15, size: 10, font, color: oscuro });
    y -= 20;
  });

  y -= 30;
  page.drawText("Alcance del servicio entregado", { x: 50, y, size: 12, font: fontBold, color: oscuro });
  y -= 20;
  const alcance = [
    "Tarjeta física con tecnología NFC, configurada y activada.",
    "Redirección automática a la página de reseñas de Google del negocio.",
    "Filtro de reputación: reseñas negativas se capturan en privado, no se publican.",
    "Panel de estadísticas con historial de toques y exportación de reportes.",
  ];
  alcance.forEach((linea) => {
    page.drawText(`•  ${linea}`, { x: 58, y, size: 9.5, font, color: oscuro, maxWidth: ANCHO - 116, lineHeight: 13 });
    y -= 18;
  });

  y -= 20;
  page.drawRectangle({ x: 50, y: y - 60, width: ANCHO - 100, height: 60, color: rgb(0.906, 0.941, 0.918) });
  page.drawText("Este documento certifica que el servicio Tapin fue entregado, instalado y", {
    x: 62, y: y - 22, size: 9.5, font, color: verdeOscuro,
  });
  page.drawText("puesto en funcionamiento en la fecha indicada, quedando activo y operativo.", {
    x: 62, y: y - 36, size: 9.5, font, color: verdeOscuro,
  });

  y -= 110;
  page.drawLine({ start: { x: 60, y }, end: { x: 260, y }, thickness: 1, color: gris });
  page.drawText("Firma - Tapin", { x: 60, y: y - 14, size: 9, font, color: gris });

  page.drawLine({ start: { x: 340, y }, end: { x: 540, y }, thickness: 1, color: gris });
  page.drawText("Firma - Cliente", { x: 340, y: y - 14, size: 9, font, color: gris });

  page.drawText(`Generado el ${new Date().toLocaleDateString("es-CO", { timeZone: zonaDe(negocio) })}`, {
    x: 50, y: 40, size: 8, font, color: gris,
  });

  const pdfBytes = await pdfDoc.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="acta-entrega-tapin-${slug}.pdf"`);
  res.send(Buffer.from(pdfBytes));
});
// Ideal para entregarle el reporte a tu cliente (Excel/Google Sheets lo abre directo).
// Visítalo así: https://tu-dominio.com/export/mi-negocio.csv?key=TU_CLAVE
app.get("/export/:slug.csv", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!autorizadoProNegocio(req, negocio, slug)) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  if (!esPro(negocio)) {
    return res.status(402).send(
      `La exportación de reportes es exclusiva del Plan Pro. ` +
      `Súbele el plan a "${negocio.nombre}" desde /editar/${slug}?key=${req.query.key} para activarla.`
    );
  }

  const datos = leerDatos();
  const eventos = (datos[slug] && datos[slug].eventos) || [];

  let csv = "Numero,Fecha y hora,Dispositivo\n";
  eventos.forEach((e, i) => {
    csv += `${i + 1},"${e.fechaLegible}",${e.dispositivo}\n`;
  });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="tapin-${slug}.csv"`);
  res.send(csv);
});

// Envía (y registra) el reporte mensual de un negocio. Se usa tanto desde la
// ruta individual /notificar/:slug como desde el envío masivo a todos los
// negocios Pro. Cada intento queda guardado en datos[slug].reportesEnviados
// con fecha y si fue exitoso — así queda un historial consultable, no solo
// un envío silencioso que nadie puede confirmar después.
async function enviarReporteMensualNegocio(slug, negocio, baseUrl) {
  if (!esPro(negocio)) {
    return { ok: false, motivo: "Este negocio no es Plan Pro." };
  }
  if (!negocio.email) {
    return { ok: false, motivo: "Este negocio no tiene 'email' configurado." };
  }
  if (negocio.alertas && negocio.alertas.reporteMensual === false) {
    return { ok: false, motivo: "El negocio desactivó el reporte mensual en su configuración." };
  }

  const datos = leerDatos();
  const eventos = (datos[slug] && datos[slug].eventos) || [];
  const r = calcularResumen(eventos);
  const recomendaciones = generarRecomendaciones(eventos, r, negocio);
  const promedio = promedioSector(negocio.categoria, slug, datos);
  const horas = analizarHoras(eventos, negocio);

  let comparativo = "";
  if (promedio !== null) {
    if (r.semana > promedio) {
      comparativo = `Estás <b>por encima</b> del promedio de negocios de tu categoría (${r.semana} vs ${promedio} toques/semana).`;
    } else if (r.semana < promedio) {
      comparativo = `Estás <b>por debajo</b> del promedio de tu categoría (${r.semana} vs ${promedio} toques/semana). Hay espacio para mejorar.`;
    } else {
      comparativo = `Estás justo en el promedio de tu categoría (${promedio} toques/semana).`;
    }
  }

  const horaTexto = (h) => `${h}:00 - ${(h + 1) % 24}:00`;
  let picosHtml = "";
  if (horas.totalMes > 0) {
    let tendenciaTexto;
    if (horas.tendenciaPico > 0) {
      tendenciaTexto = `subiendo (+${horas.tendenciaPico} toques esta semana vs. la anterior en esa hora)`;
    } else if (horas.tendenciaPico < 0) {
      tendenciaTexto = `bajando (${horas.tendenciaPico} toques esta semana vs. la anterior en esa hora)`;
    } else {
      tendenciaTexto = `estable comparado con la semana anterior`;
    }
    picosHtml = `
      <h3 style="font-size:0.95rem;margin:20px 0 8px;">Picos y caídas por hora</h3>
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        <div style="background:${MARCA.crema};border-radius:10px;padding:12px;flex:1;">
          <div style="font-size:0.7rem;color:#888;">Hora pico</div>
          <div style="font-size:1.1rem;font-weight:700;color:${MARCA.verde};">${horaTexto(horas.picoHora)}</div>
          <div style="font-size:0.72rem;color:#888;">${horas.maxToques} toques</div>
        </div>
        <div style="background:${MARCA.crema};border-radius:10px;padding:12px;flex:1;">
          <div style="font-size:0.7rem;color:#888;">Hora más floja</div>
          <div style="font-size:1.1rem;font-weight:700;color:${MARCA.rojo};">${horas.horaCaida != null ? horaTexto(horas.horaCaida) : "—"}</div>
          <div style="font-size:0.72rem;color:#888;">${horas.minToques} toques</div>
        </div>
      </div>
      <p style="font-size:0.85rem;color:#555;">Tu hora pico está <b>${tendenciaTexto}</b>.</p>
    `;
  }

  const recosHtml = recomendaciones
    .map((texto) => `<div style="background:#F1F7F4;border-left:3px solid ${MARCA.verde};border-radius:8px;padding:12px 14px;font-size:0.88rem;margin-bottom:8px;color:#1F3D2E;">${texto}</div>`)
    .join("");

  const pdfBytes = await generarInformePDF(negocio, slug);

  // Guardamos una copia del PDF en el disco persistente, organizada por
  // negocio y mes — así queda un archivo histórico consultable después,
  // no solo un correo que se manda y se olvida.
  const mesArchivo = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const carpetaReportes = path.join(DATA_DIR, "reportes", slug);
  try {
    fs.mkdirSync(carpetaReportes, { recursive: true });
    fs.writeFileSync(path.join(carpetaReportes, `${mesArchivo}.pdf`), Buffer.from(pdfBytes));
  } catch (err) {
    console.error(`[reportes] No se pudo guardar el PDF de ${slug}:`, err.message);
  }

  const resultado = await enviarEmail(
    negocio.email,
    `📊 Reporte mensual de Tapin — ${negocio.nombre}`,
    `
      <div style="font-family:-apple-system,Arial,sans-serif;max-width:520px;">
        <h2 style="color:${MARCA.verdeOscuro};margin-bottom:2px;">${negocio.nombre}</h2>
        <p style="color:#888;font-size:0.85rem;margin-top:0;">Reporte generado el ${new Date().toLocaleDateString("es-CO", { timeZone: zonaDe(negocio) })}</p>
        <div style="display:flex;gap:10px;margin:18px 0;">
          <div style="background:${MARCA.crema};border-radius:10px;padding:14px;flex:1;text-align:center;">
            <div style="font-size:1.4rem;font-weight:700;color:${MARCA.verde};">${r.total}</div>
            <div style="font-size:0.7rem;color:#888;">Total</div>
          </div>
          <div style="background:${MARCA.crema};border-radius:10px;padding:14px;flex:1;text-align:center;">
            <div style="font-size:1.4rem;font-weight:700;color:${MARCA.verde};">${r.hoy}</div>
            <div style="font-size:0.7rem;color:#888;">Hoy</div>
          </div>
          <div style="background:${MARCA.crema};border-radius:10px;padding:14px;flex:1;text-align:center;">
            <div style="font-size:1.4rem;font-weight:700;color:${MARCA.verde};">${r.semana}</div>
            <div style="font-size:0.7rem;color:#888;">7 días</div>
          </div>
        </div>
        ${comparativo ? `<p style="font-size:0.9rem;background:${MARCA.verdeClaro};padding:12px 14px;border-radius:8px;color:${MARCA.verdeOscuro};">📈 ${comparativo}</p>` : ""}
        ${picosHtml}
        <h3 style="font-size:0.95rem;margin:20px 0 8px;">Recomendaciones</h3>
        ${recosHtml}
        <p style="font-size:0.82rem;color:#555;margin-top:20px;">📎 Adjunto va el informe completo en PDF, con el detalle de la gráfica por hora y todas tus interacciones recientes.</p>
        <p style="font-size:0.78rem;color:#999;margin-top:12px;">Ver panel completo: ${baseUrl}/mi-panel/${slug}?key=${negocio.claveAcceso || ""}</p>
      </div>
    `,
    [{ filename: `informe-tapin-${slug}.pdf`, content: Buffer.from(pdfBytes) }]
  );

  // Registramos el intento (exitoso o no) para que quede historial consultable.
  const ahora = new Date();
  const datosLog = leerDatos();
  if (!datosLog[slug]) datosLog[slug] = { total: 0, eventos: [] };
  if (!datosLog[slug].reportesEnviados) datosLog[slug].reportesEnviados = [];
  datosLog[slug].reportesEnviados.push({
    fechaISO: ahora.toISOString(),
    fechaLegible: ahora.toLocaleDateString("es-CO", { timeZone: zonaDe(negocio) }),
    mes: `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, "0")}`,
    exitoso: !!resultado.ok,
    motivo: resultado.ok ? null : resultado.motivo,
  });
  guardarDatos(datosLog);

  return resultado.ok ? { ok: true } : { ok: false, motivo: resultado.motivo };
}

// Envía el reporte mensual de un solo negocio. Puedes seguir usando esto
// individualmente, pero /enviar-reportes-mensuales (más abajo) ya manda a
// TODOS los Pro de una sola vez — ya no necesitas un cron por cada negocio.
// Visítalo así: https://tu-dominio.com/notificar/mi-negocio?key=TU_CLAVE
app.get("/notificar/:slug", limitarIntentosAdmin, async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const resultado = await enviarReporteMensualNegocio(slug, negocio, baseUrl);

  if (resultado.ok) {
    res.send(`Reporte mensual enviado a ${negocio.email}.`);
  } else {
    res.status(500).send("No se pudo enviar: " + resultado.motivo);
  }
});

// Envía el reporte mensual a TODOS los negocios Pro de una sola vez, y deja
// registrado quién sí y quién no. Un solo cron mensual (día 1 de cada mes,
// por ejemplo) apuntando aquí reemplaza tener que acordarte de mandar cada
// reporte a mano o configurar un cron por cada negocio.
// Visítalo así: https://tu-dominio.com/enviar-reportes-mensuales?key=TU_CLAVE
app.get("/enviar-reportes-mensuales", limitarIntentosAdmin, async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const negocios = todosLosNegocios();
  const resultado = [];

  for (const slug in negocios) {
    const negocio = negocios[slug];
    if (!esPro(negocio)) continue;
    try {
      const r = await enviarReporteMensualNegocio(slug, negocio, baseUrl);
      resultado.push({ slug, nombre: negocio.nombre, ok: r.ok, motivo: r.motivo || null });
    } catch (err) {
      resultado.push({ slug, nombre: negocio.nombre, ok: false, motivo: err.message });
    }
  }

  res.json({
    ok: true,
    enviados: resultado.filter((r) => r.ok).length,
    fallidos: resultado.filter((r) => !r.ok).length,
    detalle: resultado,
  });
});

// Idea 14/23: revisa que el link de Google de cada negocio siga respondiendo
// (a veces Google cambia o borra fichas). Corre por cron, igual que los
// otros procesos automáticos — no bloquea nada, solo te avisa por correo si
// algo quedó roto, para arreglarlo antes de que un cliente se tope con el error.
// Visítalo así: https://tu-dominio.com/verificar-links-google?key=TU_CLAVE
app.get("/verificar-links-google", limitarIntentosAdmin, async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const negocios = todosLosNegocios();
  const rotos = [];

  for (const slug in negocios) {
    const negocio = negocios[slug];
    if (!negocio.googleUrl) continue;
    try {
      const resp = await fetch(negocio.googleUrl, { method: "GET", redirect: "follow" });
      if (!resp.ok) {
        rotos.push({ slug, nombre: negocio.nombre, url: negocio.googleUrl, estado: resp.status });
      }
    } catch (err) {
      rotos.push({ slug, nombre: negocio.nombre, url: negocio.googleUrl, estado: "sin respuesta" });
    }
  }

  if (rotos.length > 0 && process.env.EMAIL_USER) {
    const filas = rotos
      .map((r) => `<li><b>${r.nombre}</b> (${r.slug}) — estado: ${r.estado}<br><span style="font-size:0.8rem;color:#888;">${r.url}</span></li>`)
      .join("");
    await enviarEmail(
      process.env.EMAIL_USER,
      `⚠ ${rotos.length} link${rotos.length > 1 ? "s" : ""} de Google roto${rotos.length > 1 ? "s" : ""} en Tapin`,
      `<p>Estos negocios tienen un link de Google que no está respondiendo bien:</p><ul>${filas}</ul>`
    ).catch((err) => console.error("[verificar-links-google] Error enviando correo:", err.message));
  }

  res.json({ ok: true, revisados: Object.keys(negocios).length, rotos: rotos.length, detalle: rotos });
});

// Manda los resúmenes agrupados de quejas (diario/semanal) a los negocios
// que eligieron esa frecuencia en vez de "al instante" — visítala con un
// cron diario (revisa sola si a cada negocio ya le toca según su frecuencia).
// Visítala así: https://tu-dominio.com/enviar-resumenes-quejas?key=TU_CLAVE
app.get("/enviar-resumenes-quejas", limitarIntentosAdmin, async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("No autorizado.");

  const negocios = todosLosNegocios();
  const datos = leerDatos();
  const ahora = new Date();
  const resultado = [];

  for (const slug in negocios) {
    const negocio = negocios[slug];
    if (!esPro(negocio) || !negocio.email) continue;
    const alertas = negocio.alertas || {};
    if (alertas.quejas === false) continue;
    const frecuencia = alertas.frecuenciaQuejas;
    if (frecuencia !== "diario" && frecuencia !== "semanal") continue;

    const horasEspera = frecuencia === "diario" ? 24 : 24 * 7;
    const ultimoEnvio = negocio.ultimoResumenQuejas ? new Date(negocio.ultimoResumenQuejas) : null;
    const yaToca = !ultimoEnvio || (ahora - ultimoEnvio) >= horasEspera * 60 * 60 * 1000;
    if (!yaToca) continue;

    const desde = ultimoEnvio || new Date(ahora.getTime() - horasEspera * 60 * 60 * 1000);
    const quejas = ((datos[slug] && datos[slug].quejas) || []).filter((q) => new Date(q.fechaISO) >= desde);

    // Se actualiza la fecha de "último resumen" así no haya quejas nuevas —
    // para que el reloj de "cada cuánto" se mantenga estable, no se recorra.
    guardarCambiosNegocio(slug, negocio, { ultimoResumenQuejas: ahora.toISOString() });

    if (quejas.length === 0) {
      resultado.push({ slug, enviado: false, motivo: "sin quejas nuevas" });
      continue;
    }

    const filas = quejas
      .map((q) => `<li style="margin-bottom:10px;"><b>${q.fechaLegible}</b><br>"${escaparHtml(q.comentario)}"${q.telefono ? `<br>Tel: ${escaparHtml(q.telefono)}` : ""}</li>`)
      .join("");
    try {
      await enviarEmail(
        negocio.email,
        `Resumen ${frecuencia === "diario" ? "diario" : "semanal"} de retroalimentación — ${negocio.nombre}`,
        `<p>Tuviste <b>${quejas.length}</b> comentario${quejas.length > 1 ? "s" : ""} privado${quejas.length > 1 ? "s" : ""} ${frecuencia === "diario" ? "hoy" : "esta semana"}:</p>
         <ul>${filas}</ul>
         <p>Puedes verlas y marcarlas en tu panel Pro.</p>`
      );
      resultado.push({ slug, enviado: true, cantidad: quejas.length });
    } catch (err) {
      console.error("[enviar-resumenes-quejas] Error:", err.message);
      resultado.push({ slug, enviado: false, motivo: "error de envío" });
    }
  }

  res.json({ ok: true, procesados: resultado.length, detalle: resultado });
});

// Avisa por correo a los negocios con Plan Pro anual cuando les quedan 7 días
// para vencer — para que renueven a tiempo y no se les caiga el plan sin
// darse cuenta. Visítala con un cron diario, solo manda un correo por negocio
// (usa "avisoVencimientoEnviado" para no repetirlo cada día que corra el cron).
app.get("/avisar-vencimiento-anual", limitarIntentosAdmin, async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("No autorizado.");

  const negocios = todosLosNegocios();
  const ahora = new Date();
  const EN_7_DIAS = new Date(ahora.getTime() + 7 * 24 * 60 * 60 * 1000);
  const resultado = [];

  for (const slug in negocios) {
    const negocio = negocios[slug];
    if (negocio.plan !== "pro" || negocio.billingType !== "anual" || !negocio.proAnualHasta) continue;
    const vence = new Date(negocio.proAnualHasta);
    if (vence > EN_7_DIAS || vence < ahora) continue; // todavía falta más de 7 días, o ya venció (no insistir)
    if (negocio.avisoVencimientoEnviado === negocio.proAnualHasta) continue; // ya se avisó para esta fecha de vencimiento

    if (negocio.email) {
      try {
        const tokenRenovar = generarLinkAccesoNegocio(slug, 14);
        await enviarEmail(
          negocio.email,
          `Tu Plan Pro anual vence pronto — ${negocio.nombre}`,
          `<p>Tu Plan Pro anual de <b>${negocio.nombre}</b> vence el <b>${vence.toLocaleDateString("es-CO")}</b>.</p>
           <p>Para no perder el acceso a las funciones Pro, renueva desde tu panel antes de esa fecha.</p>
           <p><a href="${req.protocol}://${req.get("host")}/mejorar-a-pro/${slug}?key=${tokenRenovar}&plan=anual">Renovar mi Plan Pro anual</a></p>`
        );
        guardarCambiosNegocio(slug, negocio, { avisoVencimientoEnviado: negocio.proAnualHasta });
        resultado.push({ slug, avisado: true });
      } catch (err) {
        console.error("[avisar-vencimiento-anual] Error:", err.message);
        resultado.push({ slug, avisado: false, motivo: "error de envío" });
      }
    }
  }

  res.json({ ok: true, revisados: resultado.length, detalle: resultado });
});

// ---------- Historial de reportes mensuales guardados ----------
// Lista los PDFs de reportes que se han guardado en disco para un negocio,
// con link de descarga para cada mes. Accesible por el admin o por el propio
// negocio con su clave.
app.get("/reportes-guardados/:slug", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!autorizadoProNegocio(req, negocio, slug)) {
    return res.status(401).send("No autorizado.");
  }

  const carpeta = path.join(DATA_DIR, "reportes", slug);
  let archivos = [];
  try {
    archivos = fs.readdirSync(carpeta)
      .filter((f) => f.endsWith(".pdf"))
      .sort()
      .reverse();
  } catch {
    archivos = [];
  }

  const filas = archivos
    .map((f) => {
      const mes = f.replace(".pdf", "");
      const [anio, mesNum] = mes.split("-");
      const nombreMes = new Date(`${anio}-${mesNum}-01`).toLocaleDateString("es-CO", { month: "long", year: "numeric" });
      return `<tr>
        <td style="text-transform:capitalize;">${nombreMes}</td>
        <td><a href="/reportes-guardados/${slug}/${mes}.pdf?key=${req.query.key}">Descargar PDF</a></td>
      </tr>`;
    })
    .join("");

  res.send(`
    <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Reportes guardados — ${negocio.nombre}</title>
      <style>
        ${ESTILO_BASE}
        table{border-collapse:collapse;width:100%;max-width:500px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid ${MARCA.borde};}
        th,td{padding:12px 16px;text-align:left;border-bottom:1px solid ${MARCA.borde};font-size:0.88rem;}
        th{background:${MARCA.verdeOscuro};color:#fff;font-size:0.72rem;text-transform:uppercase;}
        a{color:${MARCA.verde};font-weight:600;text-decoration:none;}
      </style></head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div></div>
        <div class="content">
          <div class="eyebrow">Historial · ${negocio.nombre}</div>
          <h1 class="titulo-pagina">Reportes mensuales</h1>
          <div class="subtitulo">Cada reporte mensual queda guardado aquí, no solo enviado por correo.</div>

          <div style="background:${MARCA.verdeClaro};border-radius:10px;padding:14px 16px;margin-bottom:20px;max-width:500px;
                      display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
            <div>
              <b style="font-size:0.88rem;">Datos en bruto (CSV)</b>
              <div style="font-size:0.78rem;color:${MARCA.textoSuave};margin-top:2px;">Todos tus toques hasta hoy, fecha y dispositivo — listo para abrir en Excel.</div>
            </div>
            <a href="/export/${slug}.csv?key=${req.query.key}"
               style="flex-shrink:0;background:${MARCA.verde};color:#fff;text-decoration:none;font-weight:700;
                      font-size:0.8rem;padding:9px 16px;border-radius:8px;">Descargar CSV</a>
          </div>

          <table>
            <tr><th>Mes</th><th>Descarga</th></tr>
            ${filas || `<tr><td colspan="2">Todavía no hay reportes guardados para este negocio.</td></tr>`}
          </table>
        </div>
      </body>
    </html>
  `);
});

// Descarga un PDF de reporte guardado específico.
app.get("/reportes-guardados/:slug/:mes.pdf", (req, res) => {
  const { slug, mes } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!autorizadoProNegocio(req, negocio, slug)) {
    return res.status(401).send("No autorizado.");
  }
  // Valida que "mes" tenga exactamente el formato AAAA-MM esperado — sin esto,
  // alguien podría meter "../../../algo" en la URL e intentar leer archivos
  // fuera de la carpeta de reportes (path traversal).
  if (!/^\d{4}-\d{2}$/.test(mes)) {
    return res.status(400).send("Formato de mes inválido.");
  }

  const archivo = path.join(DATA_DIR, "reportes", slug, `${mes}.pdf`);
  if (!fs.existsSync(archivo)) {
    return res.status(404).send("Ese reporte no existe.");
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="reporte-${slug}-${mes}.pdf"`);
  res.send(fs.readFileSync(archivo));
});

// Misma información en JSON, útil si luego quieres conectar esto a un dashboard propio.
// Misma información en JSON, útil para conectar la app móvil o un dashboard propio.
// Incluye nombre y categoría de cada negocio (no solo los eventos), para que
// la app no tenga que adivinar esa parte.
app.get("/stats.json", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ error: "No autorizado" });
  }
  const datos = leerDatos();
  const negociosTotal = todosLosNegocios();
  const resultado = {};
  for (const slug in negociosTotal) {
    resultado[slug] = {
      nombre: negociosTotal[slug].nombre,
      categoria: negociosTotal[slug].categoria || null,
      total: (datos[slug] && datos[slug].total) || 0,
      eventos: (datos[slug] && datos[slug].eventos) || [],
    };
  }
  res.json(resultado);
});

// ---------- Respaldo manual de todos los datos ----------
// No hay backup automático de los archivos JSON (viven solo en el disco de
// Render) — esto te da un botón para descargar TODO en un solo archivo
// cuando quieras, sin depender de ninguna librería nueva que instalar.
// Recomendado: descárgalo a mano cada tanto, o prográmalo en cron-job.org
// para que te lo mande por correo cada semana (ver /respaldo-correo abajo).
// Visítalo así: https://tu-dominio.com/respaldo?key=TU_CLAVE
// Muestra el registro de acciones administrativas sensibles (crear/editar/
// quitar negocios, generar códigos) — quién hizo qué y cuándo, para tener
// rastro si algo raro pasa o simplemente para acordarte de tus propios cambios.
// Visítalo así: https://tu-dominio.com/auditoria?key=TU_CLAVE
app.get("/auditoria", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  let registros = [];
  try {
    if (fs.existsSync(AUDITORIA_GLOBAL_FILE)) registros = JSON.parse(fs.readFileSync(AUDITORIA_GLOBAL_FILE, "utf8"));
  } catch {
    registros = [];
  }
  const filas = registros
    .slice()
    .reverse()
    .slice(0, 300)
    .map((r) => `<tr>
        <td>${escaparHtml(r.fechaLegible)}</td>
        <td><span class="pill">${escaparHtml(r.accion)}</span></td>
        <td>${escaparHtml(r.detalle)}</td>
        <td class="ip">${escaparHtml(r.ip || "—")}</td>
      </tr>`)
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Auditoría — Tapin</title>
        <style>
          ${ESTILO_BASE}
          table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid ${MARCA.borde};}
          th,td{padding:11px 16px;text-align:left;font-size:0.84rem;border-bottom:1px solid ${MARCA.borde};}
          th{background:${MARCA.verdeOscuro};color:#fff;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;}
          .pill{background:${MARCA.verdeClaro};color:${MARCA.verdeOscuro};padding:3px 10px;border-radius:100px;font-size:0.72rem;font-weight:700;}
          .ip{font-family:monospace;font-size:0.76rem;color:${MARCA.textoSuave};}
        </style>
      </head>
      <body>
        <div class="topbar">
          <div>${logoSvg("#FFFFFF", 30)}</div>
          <a class="back" href="/stats?key=${req.query.key}">&larr; Volver al panel</a>
        </div>
        <div class="content">
          <div class="eyebrow">Seguridad</div>
          <h1 class="titulo-pagina">Auditoría del sistema</h1>
          <div class="subtitulo">Las últimas ${Math.min(300, registros.length)} acciones administrativas registradas (de ${registros.length} en total).</div>
          <table>
            <tr><th>Fecha</th><th>Acción</th><th>Detalle</th><th>IP</th></tr>
            ${filas || "<tr><td colspan='4'>Todavía no hay acciones registradas.</td></tr>"}
          </table>
        </div>
      </body>
    </html>
  `);
});

app.get("/respaldo", limitarIntentosAdmin, (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const archivos = ["data.json", "codigos.json", "clientes.json", "sesiones-clientes.json", "pedidos.json", "tokens.json"];
  const respaldo = { generadoEl: new Date().toISOString() };
  for (const archivo of archivos) {
    const ruta = path.join(DATA_DIR, archivo);
    try {
      respaldo[archivo] = fs.existsSync(ruta) ? JSON.parse(fs.readFileSync(ruta, "utf8")) : null;
    } catch (err) {
      respaldo[archivo] = { errorLeyendo: err.message };
    }
  }
  const nombreArchivo = `respaldo-tapin-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${nombreArchivo}"`);
  res.send(JSON.stringify(respaldo, null, 2));
});

// Igual que /respaldo, pero te lo manda por correo en vez de descargarlo —
// pensado para programarlo en cron-job.org una vez a la semana, así el
// respaldo te llega solo sin que tengas que acordarte de entrar a bajarlo.
// Visítalo así: https://tu-dominio.com/respaldo-correo?key=TU_CLAVE
app.get("/respaldo-correo", limitarIntentosAdmin, async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const destino = req.query.a || process.env.ADMIN_EMAIL || process.env.EMAIL_USER;
  if (!destino) {
    return res.status(400).send("Falta a quién mandarlo — agrega &a=tu@correo.com o configura ADMIN_EMAIL/EMAIL_USER en Render.");
  }
  const archivos = ["data.json", "codigos.json", "clientes.json", "sesiones-clientes.json", "pedidos.json", "tokens.json"];
  const respaldo = { generadoEl: new Date().toISOString() };
  for (const archivo of archivos) {
    const ruta = path.join(DATA_DIR, archivo);
    try {
      respaldo[archivo] = fs.existsSync(ruta) ? JSON.parse(fs.readFileSync(ruta, "utf8")) : null;
    } catch (err) {
      respaldo[archivo] = { errorLeyendo: err.message };
    }
  }
  const contenido = Buffer.from(JSON.stringify(respaldo, null, 2), "utf8");
  const nombreArchivo = `respaldo-tapin-${new Date().toISOString().slice(0, 10)}.json`;
  const resultado = await enviarEmail(
    destino,
    `Respaldo de datos Tapin — ${new Date().toLocaleDateString("es-CO")}`,
    `<p>Adjunto va el respaldo completo de todos tus datos (negocios, códigos, clientes, pedidos) en formato JSON.</p>
     <p style="font-size:0.82rem;color:#888;">Guárdalo en un lugar seguro — tiene información sensible de tus negocios y clientes.</p>`,
    [{ filename: nombreArchivo, content: contenido }]
  );
  if (resultado.ok) {
    res.send(`Respaldo enviado a ${destino}.`);
  } else {
    res.status(500).send("No se pudo enviar: " + resultado.motivo);
  }
});
// ---------- Dashboard de clientes: mapa de calor público ----------
// Calcula una "reputación" aproximada de un negocio a partir de sus quejas
// privadas vs. su total de toques (no tenemos un conteo directo de "positivos",
// así que la aproximamos: total - quejas = toques que no terminaron en queja).
function reputacionNegocio(slug, datos) {
  const info = datos[slug] || { total: 0 };
  const quejas = (info.quejas || []).length;
  const total = info.total || 0;
  const positivos = Math.max(0, total - quejas);
  const porcentaje = total > 0 ? Math.round((positivos / total) * 100) : 100;
  const estrellas = total > 0 ? Math.max(1, Math.round((positivos / total) * 5)) : 5;
  return { total, quejas, porcentaje, estrellas };
}

// Página pública para clientes: mapa de calor con todos los negocios Tapin
// que tengan ubicación configurada, mostrando su reputación al tocarlos.
// Visítalo así: https://tu-dominio.com/descubre
// Página pública "Conoce Tapin" — explica cómo funciona la tarjeta y qué
// incluye cada plan, para cualquiera que quiera entender el producto antes
// de comprarlo (o para mandarle el link a un cliente potencial).
app.get("/conoce", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Cómo conseguir más reseñas en Google — Tarjeta NFC Tapin | Colombia</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.crema};
               margin:0;color:${MARCA.texto};}
          .hero{background:${MARCA.verdeOscuro};color:#fff;padding:64px 24px 40px;text-align:center;position:relative;overflow:hidden;}
          .hero h1{font-size:2rem;margin:14px 0 10px;}
          .hero p{color:#CFE3D8;font-size:1rem;max-width:480px;margin:0 auto;}

          .tarjeta-wrap{margin:44px auto 8px;height:220px;display:flex;align-items:center;justify-content:center;perspective:800px;}
          .tarjeta-nfc{width:210px;height:210px;border-radius:22px;position:relative;
                       background:#FFFFFF;
                       box-shadow:0 30px 60px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08);
                       animation:flotar 4.5s ease-in-out infinite;
                       display:flex;flex-direction:column;align-items:center;justify-content:center;
                       padding:20px;}
          .tarjeta-logo{position:absolute;top:18px;left:22px;font-size:1.05rem;font-weight:800;letter-spacing:-0.02em;color:${MARCA.texto};}
          .tarjeta-nfc-icono{position:absolute;top:18px;right:20px;width:22px;height:22px;opacity:0.7;}
          .tarjeta-google{font-size:1.6rem;font-weight:700;letter-spacing:-0.01em;margin-top:6px;}
          .tarjeta-google span:nth-child(1){color:#4285F4;}
          .tarjeta-google span:nth-child(2){color:#EA4335;}
          .tarjeta-google span:nth-child(3){color:#FBBC05;}
          .tarjeta-google span:nth-child(4){color:#4285F4;}
          .tarjeta-google span:nth-child(5){color:#34A853;}
          .tarjeta-google span:nth-child(6){color:#EA4335;}
          .tarjeta-estrellas{color:${MARCA.oro};font-size:1.05rem;letter-spacing:2px;margin:6px 0 8px;}
          .tarjeta-texto{font-size:0.68rem;color:${MARCA.textoSuave};text-align:center;line-height:1.3;margin-bottom:10px;}
          .tarjeta-mano{width:26px;height:26px;opacity:0.75;}

          @keyframes flotar {
            0%   { transform: translateY(0) rotate(-4deg); }
            50%  { transform: translateY(-16px) rotate(2deg); }
            100% { transform: translateY(0) rotate(-4deg); }
          }
          @media (prefers-reduced-motion: reduce) {
            .tarjeta-nfc{ animation:none; }
          }

          .contenido{max-width:720px;margin:0 auto;padding:48px 24px 80px;}
          .paso{display:flex;gap:18px;margin-bottom:28px;align-items:flex-start;}
          .paso-num{width:36px;height:36px;border-radius:50%;background:${MARCA.verde};color:#fff;
                    display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;}
          .paso h3{margin:0 0 4px;font-size:1.05rem;}
          .paso p{margin:0;color:${MARCA.textoSuave};font-size:0.9rem;line-height:1.5;}
          .seccion-titulo{font-size:1.3rem;font-weight:700;margin:56px 0 22px;text-align:center;}
          .planes{display:flex;gap:20px;flex-wrap:wrap;}
          .plan{flex:1;min-width:260px;background:#fff;border-radius:18px;padding:28px;border:1px solid ${MARCA.borde};}
          .plan.pro{border:2px solid ${MARCA.oro};position:relative;}
          .plan-badge{position:absolute;top:-12px;right:20px;background:${MARCA.oro};color:#fff;font-size:0.68rem;
                      font-weight:800;padding:4px 12px;border-radius:100px;}
          .plan-nombre{font-size:0.85rem;font-weight:700;color:${MARCA.textoSuave};text-transform:uppercase;letter-spacing:0.03em;}
          .plan-precio{font-size:1.8rem;font-weight:800;margin:6px 0 4px;}
          .plan-precio span{font-size:0.85rem;font-weight:500;color:${MARCA.textoSuave};}
          .plan ul{list-style:none;padding:0;margin:18px 0 0;}
          .plan li{padding:8px 0;border-top:1px solid ${MARCA.borde};font-size:0.88rem;display:flex;gap:8px;}
          .plan li:first-child{border-top:none;}

          .precios-grid{display:flex;gap:24px;flex-wrap:wrap;margin-top:14px;}
          .precio-card{flex:1;min-width:280px;background:#fff;border-radius:14px;border:1px solid ${MARCA.borde};
                       padding:0;overflow:hidden;box-shadow:0 1px 3px rgba(11,61,44,0.04);}
          .precio-card-titulo{font-size:0.78rem;font-weight:700;color:#fff;background:${MARCA.verdeOscuro};
                               padding:14px 20px;text-transform:uppercase;letter-spacing:0.04em;}
          .tabla-precios{width:100%;border-collapse:collapse;font-size:0.88rem;}
          .tabla-precios th{text-align:left;padding:10px 20px;font-size:0.68rem;text-transform:uppercase;
                             letter-spacing:0.03em;color:${MARCA.textoSuave};font-weight:600;border-bottom:1px solid ${MARCA.borde};}
          .tabla-precios td{padding:11px 20px;border-bottom:1px solid ${MARCA.borde};color:${MARCA.texto};}
          .tabla-precios tr:last-child td{border-bottom:none;font-weight:700;color:${MARCA.verdeOscuro};background:${MARCA.verdeClaro};}

          .plan-anual{display:flex;align-items:center;justify-content:space-between;gap:12px;
                      background:${MARCA.verdeOscuro};border-radius:12px;padding:14px 18px;margin:16px 0;}
          .plan-anual-etiqueta{font-size:0.66rem;text-transform:uppercase;letter-spacing:0.04em;color:#CFE3D8;}
          .plan-anual-precio{font-size:1.15rem;font-weight:800;color:#fff;margin-top:2px;}
          .plan-anual-precio span{font-size:0.72rem;font-weight:500;color:#CFE3D8;}
          .plan-anual-badge{background:${MARCA.oro};color:#fff;font-size:0.72rem;font-weight:800;
                             padding:6px 12px;border-radius:100px;white-space:nowrap;}
          .check{color:${MARCA.verde};font-weight:800;flex-shrink:0;}
          .cta{display:block;text-align:center;background:${MARCA.oro};color:#fff;text-decoration:none;
               padding:16px;border-radius:12px;font-weight:700;margin-top:60px;}
          .nota{background:${MARCA.verdeClaro};border-radius:12px;padding:18px 20px;margin-top:40px;font-size:0.86rem;color:${MARCA.verdeOscuro};}

          /* Landing visual: conserva el contenido de Tapin, con una presentación editorial. */
          @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600;1,700&display=swap');
          :root{--ink:#062e1e;--forest:#0d432b;--cream:#fbf6e9;--paper:#fffefd;--muted:#50695b;--line:#dedccc;--gold:#e8a623;}
          body{font-family:'DM Sans','Segoe UI',sans-serif;background:var(--cream);color:var(--ink);line-height:1.48;}
          .site-header{height:74px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 max(24px,calc((100vw - 1120px)/2));background:rgba(251,246,233,.94);position:sticky;top:0;z-index:10;backdrop-filter:blur(10px);}
          .site-brand{display:flex;align-items:center;}
          .site-nav{display:flex;gap:34px;align-items:center;}
          .site-nav a{font-size:.88rem;color:var(--ink);text-decoration:none;font-weight:500;}
          .site-order{background:var(--forest)!important;color:#fff!important;padding:12px 20px;border-radius:999px;font-weight:700!important;}
          .hero{background:var(--cream);color:var(--ink);padding:92px max(24px,calc((100vw - 1120px)/2)) 84px;text-align:left;min-height:590px;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,.8fr);grid-template-rows:auto auto auto auto;column-gap:74px;align-items:center;position:relative;}
          .hero>div:first-child{grid-column:1;grid-row:1;display:none;}
          .hero h1{grid-column:1;grid-row:2;font-family:'Playfair Display',Georgia,serif;font-size:clamp(3rem,5.5vw,5.4rem);letter-spacing:-.065em;line-height:.96;max-width:580px;margin:0 0 24px;color:var(--ink);}
          .hero h1::before{content:'HECHO EN COLOMBIA · SIN APPS · SIN FRICCIÓN';display:block;font-family:'DM Sans',sans-serif;color:#456c58;font-size:.72rem;letter-spacing:.08em;font-weight:700;margin-bottom:28px;}
          .hero p{grid-column:1;grid-row:3;max-width:520px;color:var(--muted);font-size:1.06rem;line-height:1.65;margin:0;}
          .tarjeta-wrap{grid-column:2;grid-row:1 / span 4;margin:0;height:420px;justify-content:center;align-self:center;position:relative;}
          .tarjeta-wrap::before{content:'';position:absolute;width:335px;height:335px;border-radius:50%;background:radial-gradient(circle,#f3d576 0%,rgba(243,213,118,.2) 38%,transparent 72%);filter:blur(8px);}
          .tarjeta-nfc{z-index:1;width:238px;height:310px;border-radius:30px;box-shadow:0 25px 48px rgba(4,41,25,.26),inset 0 0 0 8px #092e20;animation:flotar 5s ease-in-out infinite;padding:26px;}
          .tarjeta-logo{top:30px;left:30px;}.tarjeta-nfc-icono{top:30px;right:28px;}.tarjeta-google{font-size:1.85rem}.tarjeta-estrellas{font-size:1.2rem;margin:11px 0}.tarjeta-texto{font-size:.78rem}.tarjeta-mano{width:31px;height:31px;}
          .contenido{max-width:1120px;padding:96px 0 102px;}
          .contenido>.paso{display:inline-flex;vertical-align:top;width:calc(33.333% - 18px);min-height:244px;background:var(--paper);border:1px solid #e1e2db;border-radius:24px;padding:34px 28px;margin:0 12px 24px 0;box-shadow:0 12px 22px rgba(9,49,30,.07);flex-direction:column;gap:20px;position:relative;overflow:hidden;}
          .contenido>.paso:nth-of-type(4){width:calc(33.333% - 18px);}
          .paso-num{background:#edf1ed;color:var(--forest);font-size:.76rem;width:45px;height:45px;}.paso h3{font-family:'Playfair Display',Georgia,serif;font-size:1.3rem;line-height:1.12;color:var(--ink);}.paso p{font-size:.92rem;color:var(--muted);line-height:1.55;}
          .seccion-titulo{font-family:'Playfair Display',Georgia,serif;font-size:clamp(2.3rem,4vw,3.7rem);line-height:1.02;letter-spacing:-.055em;text-align:left;margin:102px 0 32px;color:var(--ink);}
          .planes{gap:24px;align-items:stretch;}.plan{border:1px solid #dde1db;border-radius:28px;padding:38px 40px;box-shadow:0 12px 24px rgba(9,49,30,.06);}.plan.pro{border:1px solid #dde1db;background:linear-gradient(135deg,#fff 40%,#f9f1dd);}.plan-badge{background:var(--forest);top:26px;right:28px;}.plan-nombre{color:#526f5e;}.plan-precio{font-family:'Playfair Display',Georgia,serif;color:var(--ink);font-size:2.8rem;letter-spacing:-.05em;}.plan li{border-color:#e9e9e2;padding:9px 0;}.plan-anual{background:#f4f6ef;border:2px solid var(--forest);color:var(--ink);}.plan-anual-etiqueta,.plan-anual-precio{color:var(--ink);}.plan-anual-precio span{color:var(--muted);}.plan-anual-badge{background:var(--gold);color:var(--ink);}
          .precios-grid{gap:24px;}.precio-card{border-radius:22px;box-shadow:0 10px 22px rgba(9,49,30,.05);}.precio-card-titulo{background:var(--forest);padding:17px 22px;}.nota{background:#edf2ed;border-radius:20px;padding:24px 28px;color:var(--forest);line-height:1.6;}.cta{background:var(--forest);border-radius:999px;max-width:260px;margin:58px auto 0;padding:15px 22px;box-shadow:0 10px 22px rgba(9,67,43,.16);}
          .site-footer{border-top:1px solid var(--line);padding:26px max(24px,calc((100vw - 1120px)/2));display:flex;justify-content:space-between;gap:20px;color:#486454;font-size:.84rem;}.site-footer a{color:#345c46;text-decoration:none;}
          @media(max-width:760px){.site-header{height:64px}.site-nav a:not(.site-order){display:none}.site-order{padding:10px 15px}.hero{display:flex;flex-direction:column;padding:62px 24px 50px;min-height:auto}.hero h1{font-size:3.35rem}.hero p{font-size:1rem}.tarjeta-wrap{height:350px;width:100%;margin-top:34px}.tarjeta-nfc{transform:scale(.86)}.contenido{padding:64px 24px}.contenido>.paso,.contenido>.paso:nth-of-type(4){width:100%;min-height:0;margin-right:0}.seccion-titulo{margin-top:68px}.plan{padding:31px 26px}.site-footer{flex-direction:column;}.site-footer span:last-child{display:flex;gap:18px}.precios-grid{display:block}.precio-card{margin-bottom:20px}}
        </style>
      </head>
      <body>
        <header class="site-header">
          <a class="site-brand" href="/" aria-label="Tapin inicio">${logoSvg(MARCA.verdeOscuro, 25)}</a>
          <nav class="site-nav" aria-label="Navegación principal">
            <a href="#como-funciona">Cómo funciona</a>
            <a href="#beneficios">Beneficios</a>
            <a href="#precios">Precios</a>
            <a class="site-order" href="/pedido">Pedir tarjeta</a>
          </nav>
        </header>
        <div class="hero">
          <div>${logoSvg("#FFFFFF", 34)}</div>
          <h1>Así funciona Tapin</h1>
          <p>Tarjeta NFC para negocios en Colombia que convierte cada visita en una reseña de Google en segundos — la forma más simple de aumentar las reseñas de Google de tu negocio y cuidar tu reputación online, sin arriesgarte a que una calificación negativa se publique.</p>

          <div class="tarjeta-wrap">
            <div class="tarjeta-nfc">
              <div class="tarjeta-logo">${logoSvg(MARCA.texto, 16)}</div>
              <svg class="tarjeta-nfc-icono" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M6 9C7.5 10.2 8.4 11.9 8.4 13.8C8.4 15.7 7.5 17.4 6 18.6" stroke="${MARCA.textoSuave}" stroke-width="1.6" stroke-linecap="round"/>
                <path d="M9.5 6.5C11.8 8.4 13.2 11 13.2 14C13.2 17 11.8 19.6 9.5 21.5" stroke="${MARCA.textoSuave}" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>
              </svg>
              <div class="tarjeta-google"><span>G</span><span>o</span><span>o</span><span>g</span><span>l</span><span>e</span></div>
              <div class="tarjeta-estrellas">★★★★★</div>
              <div class="tarjeta-texto">Déjanos una reseña<br>en Google</div>
              <svg class="tarjeta-mano" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9 12V6.5C9 5.67 9.67 5 10.5 5C11.33 5 12 5.67 12 6.5V11" stroke="${MARCA.texto}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M12 11V5.5C12 4.67 12.67 4 13.5 4C14.33 4 15 4.67 15 5.5V11" stroke="${MARCA.texto}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M15 11V6.5C15 5.67 15.67 5 16.5 5C17.33 5 18 5.67 18 6.5V13C18 16.87 14.87 20 11 20C9 20 7.5 19 6.3 17.3L4 13.5C3.6 12.8 3.9 11.9 4.7 11.6C5.3 11.4 6 11.6 6.4 12.1L8 14" stroke="${MARCA.texto}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M20 5C21 6 21.5 7.3 21.5 8.5" stroke="${MARCA.oro}" stroke-width="1.4" stroke-linecap="round"/>
                <path d="M22 3C23.5 4.5 24.3 6.4 24.3 8.5" stroke="${MARCA.oro}" stroke-width="1.4" stroke-linecap="round" opacity="0.5"/>
              </svg>
            </div>
          </div>
        </div>

        <main class="contenido" id="como-funciona">
          <div class="paso">
            <div class="paso-num">1</div>
            <div><h3>El cliente toca la tarjeta</h3><p>Con el celular pegado a la tarjeta, se abre una página simple donde el cliente califica su experiencia.</p></div>
          </div>
          <div class="paso">
            <div class="paso-num">2</div>
            <div><h3>Si calificó bien, va directo a Google</h3><p>Lo mandamos automáticamente a dejar la reseña pública en tu perfil de Google — sin pasos extra, sin fricción.</p></div>
          </div>
          <div class="paso">
            <div class="paso-num">3</div>
            <div><h3>Si calificó mal, queda como retroalimentación privada</h3><p>En vez de publicarse, ese comentario llega directo a ti — nunca se vuelve una reseña negativa pública. Es información que te sirve para mejorar, no un golpe a tu reputación.</p></div>
          </div>
          <div class="paso">
            <div class="paso-num">4</div>
            <div><h3>Todo queda registrado</h3><p>Cada toque queda guardado con fecha, hora y dispositivo — tu propio historial de actividad, disponible en tu panel cuando quieras verlo.</p></div>
          </div>

          <div class="nota">
            <b>Consejo clave:</b> los datos de Tapin son tan buenos como la cantidad de gente que use la tarjeta. Si solo la usa 1 de cada 10 clientes, lo que ves en tu panel no representa lo que realmente pasa en tu negocio. Anímala con todos — en caja, en la mesa, al despedirte — para que tus estadísticas reflejen la realidad, no solo a los clientes más entusiastas.
          </div>

          <div class="seccion-titulo" id="beneficios">Qué incluye cada plan</div>
          <div class="planes">
            <div class="plan">
              <div class="plan-nombre">Pago único</div>
              <div class="plan-precio">$119.900 <span>COP</span></div>
              <p style="font-size:0.78rem;color:${MARCA.verde};font-weight:700;margin:-6px 0 14px;">Envío incluido</p>
              <ul>
                <li><span class="check">✓</span> Tarjeta NFC física + envío incluido</li>
                <li><span class="check">✓</span> Redirección automática a tus reseñas de Google</li>
                <li><span class="check">✓</span> Panel con historial y estadísticas</li>
                <li><span class="check">✓</span> Acta de entrega formal</li>
              </ul>
            </div>
            <div class="plan pro">
              <div class="plan-badge">RECOMENDADO</div>
              <div class="plan-nombre">Mensualidad Pro</div>
              <div class="plan-precio">$59.900 <span>COP / mes</span></div>
              <p style="font-size:0.78rem;color:${MARCA.verde};font-weight:700;margin:-6px 0 14px;">Desde 1 tarjeta — ver tabla de precios abajo si tienes varias</p>
              <div class="plan-anual">
                <div class="plan-anual-izq">
                  <div class="plan-anual-etiqueta">Pago anual</div>
                  <div class="plan-anual-precio">$649.900 <span>COP / año</span></div>
                </div>
                <div class="plan-anual-badge">10% más barato</div>
              </div>
              <ul>
                <li><span class="check">✓</span> Todo lo del pago único, más:</li>
                <li><span class="check">✓</span> Retroalimentación privada — lo negativo nunca se publica</li>
                <li><span class="check">✓</span> Alerta instantánea por correo ante retroalimentación negativa</li>
                <li><span class="check">✓</span> Registro completo de cada toque (fecha, hora, dispositivo)</li>
                <li><span class="check">✓</span> Reporte mensual automático con picos y caídas por hora</li>
                <li><span class="check">✓</span> Reportes en CSV, PDF y Word — te los enviamos por correo cuando los necesites</li>
                <li><span class="check">✓</span> Comparación contra el promedio de tu categoría</li>
              </ul>
            </div>
          </div>

          <div class="seccion-titulo" id="precios">Precios por cantidad</div>
          <div class="precios-grid">
            <div class="precio-card">
              <div class="precio-card-titulo">Compra de tarjetas</div>
              <table class="tabla-precios">
                <tr><th>Cantidad</th><th>Precio c/u</th><th>Ahorro</th></tr>
                ${ESCALONES_DESCUENTO.slice().reverse().map((e, i, arr) => {
                  const siguiente = arr[i + 1];
                  const rango = siguiente ? `${e.minimo}-${siguiente.minimo - 1}` : `${e.minimo}+`;
                  return `<tr><td>${rango}</td><td>$${e.precio.toLocaleString("es-CO")}</td><td>${e.descuento || "—"}</td></tr>`;
                }).join("")}
              </table>
            </div>
            <div class="precio-card">
              <div class="precio-card-titulo">Suscripción Plan Pro</div>
              <table class="tabla-precios">
                <tr><th>Tarjetas activas</th><th>Precio c/u / mes</th></tr>
                ${ESCALONES_PRO.slice().reverse().map((e, i, arr) => {
                  const siguiente = arr[i + 1];
                  const rango = siguiente ? `${e.minimo}-${siguiente.minimo - 1}` : `${e.minimo}+`;
                  return `<tr><td>${rango}</td><td>$${e.precio.toLocaleString("es-CO")}</td></tr>`;
                }).join("")}
              </table>
            </div>
          </div>

          <div class="nota">
            <b>Sobre la retroalimentación:</b> cuando un cliente no tiene una buena experiencia, esa información nunca se convierte en una reseña pública negativa. Se queda contigo, en privado, como una oportunidad para mejorar o para contactar directamente a ese cliente. Así es como Tapin ayuda a evitar reseñas negativas públicas, sin dejar de escuchar a cada cliente — la forma más simple de hacer que tus clientes dejen reseñas sin arriesgar tu reputación en línea.
          </div>

          <a class="cta" href="/pedido">Pedir mi tarjeta Tapin →</a>
        </main>
        <footer class="site-footer">
          <span>© ${new Date().getFullYear()} Tapin. Hecho en Colombia.</span>
          <span><a href="mailto:hola@tapincol.com">hola@tapincol.com</a><a href="https://wa.me/573003489609" target="_blank">WhatsApp</a></span>
        </footer>
      </body>
    </html>
  `);
});


app.get("/descubre", (req, res) => {
  const todos = todosLosNegocios();
  const datos = leerDatos();
  const cliente = clienteActual(req);
  const misFavoritos = cliente ? (cliente.favoritos || []) : [];

  const ICONOS_CATEGORIA = {
    restaurante: "🍽", peluqueria: "💇", tienda: "🛍", clinica: "🩺", otro: "📍",
  };
  const NOMBRES_CATEGORIA = {
    restaurante: "Restaurantes", peluqueria: "Peluquerías", tienda: "Tiendas", clinica: "Clínicas", otro: "Otros",
  };

  const puntos = Object.keys(todos)
    .map((slug) => ({ slug, negocio: todos[slug] }))
    .filter(({ negocio }) => negocio.lat != null && negocio.lng != null)
    .map(({ slug, negocio }) => {
      const rep = reputacionNegocio(slug, datos);
      const categoria = negocio.categoria || "otro";
      return {
        slug,
        nombre: negocio.nombre,
        categoria,
        icono: ICONOS_CATEGORIA[categoria] || ICONOS_CATEGORIA.otro,
        direccion: negocio.direccion || "",
        lat: negocio.lat,
        lng: negocio.lng,
        googleUrl: negocio.googleUrl,
        esFavorito: misFavoritos.includes(slug),
        ...rep,
      };
    });

  const categoriasPresentes = [...new Set(puntos.map((p) => p.categoria))];
  const chipsCategoria = categoriasPresentes
    .map((c) => `<button class="chip-cat" data-cat="${c}" onclick="filtrar('${c}', this)">${ICONOS_CATEGORIA[c] || "📍"} ${NOMBRES_CATEGORIA[c] || c}</button>`)
    .join("");

  const puntosJSON = JSON.stringify(puntos);
  const centroLat = puntos.length ? puntos.reduce((s, p) => s + p.lat, 0) / puntos.length : 4.8617;
  const centroLng = puntos.length ? puntos.reduce((s, p) => s + p.lng, 0) / puntos.length : -74.0397;

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Descubre negocios Tapin</title>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script>
        <style>
          ${ESTILO_BASE}
          html, body { height: 100%; }
          .content{padding:0;max-width:none;}
          .topbar{position:relative;z-index:1000;}
          #mapa{height:calc(100vh - 68px);width:100%;}

          .barra-filtros{position:absolute;top:84px;left:16px;right:16px;z-index:900;display:flex;gap:8px;
                          overflow-x:auto;padding-bottom:4px;-ms-overflow-style:none;scrollbar-width:none;}
          .barra-filtros::-webkit-scrollbar{display:none;}
          .chip-cat{flex-shrink:0;background:#fff;border:1.5px solid ${MARCA.borde};color:${MARCA.texto};
                    padding:8px 14px;border-radius:100px;font-size:0.8rem;font-weight:700;cursor:pointer;
                    box-shadow:0 2px 10px rgba(0,0,0,0.08);white-space:nowrap;}
          .chip-cat.activo{background:${MARCA.verdeOscuro};color:#fff;border-color:${MARCA.verdeOscuro};}

          .leyenda{position:absolute;bottom:20px;left:16px;z-index:900;background:#fff;border-radius:14px;
                   padding:12px 16px;box-shadow:0 4px 20px rgba(0,0,0,0.12);font-size:0.78rem;max-width:220px;}
          .leyenda-titulo{font-weight:800;margin-bottom:4px;color:${MARCA.texto};}
          .leyenda-num{color:${MARCA.verde};font-weight:800;}

          .pin-tapin{display:flex;align-items:center;justify-content:center;width:34px;height:34px;
                     border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${MARCA.verdeOscuro};
                     border:2.5px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,0.3);}
          .pin-tapin span{transform:rotate(45deg);font-size:1rem;}
          .pin-tapin.favorito{background:${MARCA.oro};}

          .popup-card{min-width:200px;}
          .popup-nombre{font-weight:800;font-size:1rem;margin-bottom:1px;}
          .popup-cat{color:${MARCA.textoSuave};font-size:0.74rem;text-transform:capitalize;margin-bottom:8px;}
          .popup-estrellas{color:${MARCA.oro};font-size:0.95rem;margin-bottom:2px;}
          .popup-pct{color:${MARCA.textoSuave};font-size:0.76rem;}
          .popup-dir{font-size:0.76rem;color:#888;margin-top:4px;}
          .popup-botones{display:flex;gap:6px;margin-top:10px;}
          .popup-link{flex:1;text-align:center;background:${MARCA.verde};color:#fff;text-decoration:none;
                      padding:8px 10px;border-radius:9px;font-size:0.78rem;font-weight:700;}
          .popup-fav{width:36px;background:${MARCA.crema};color:${MARCA.texto};text-decoration:none;
                     padding:8px;border-radius:9px;font-size:0.9rem;border:1px solid ${MARCA.borde};cursor:pointer;}
          .popup-fav.activo{background:${MARCA.oro};color:#fff;border-color:${MARCA.oro};}
          .vacio{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:900;text-align:center;
                 background:#fff;padding:24px 30px;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,0.12);}
        </style>
      </head>
      <body>
        <div class="topbar"><a class="back" href="/">&larr; Inicio</a><div>${logoSvg("#FFFFFF", 30)}</div><div style="width:60px;"></div></div>
        <div id="mapa"></div>
        ${chipsCategoria ? `<div class="barra-filtros">${chipsCategoria}</div>` : ""}
        <div class="leyenda">
          <div class="leyenda-titulo"><span class="leyenda-num">${puntos.length}</span> negocio${puntos.length === 1 ? "" : "s"} en el mapa</div>
          Entre más intenso el color de fondo, más actividad de clientes.
        </div>
        <script>
          const puntos = ${puntosJSON};
          const hayCliente = ${cliente ? "true" : "false"};
          const mapa = L.map('mapa').setView([${centroLat}, ${centroLng}], 12);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap'
          }).addTo(mapa);

          let capaCalor = null;
          let marcadores = [];
          let filtroActivo = null;

          async function alternarFavorito(slug, boton) {
            if (!hayCliente) { window.location.href = '/cliente'; return; }
            const esFav = boton.classList.contains('activo');
            const ruta = esFav ? 'quitar' : 'guardar';
            await fetch('/favoritos/' + slug + '/' + ruta, { method: 'POST' });
            boton.classList.toggle('activo');
            boton.textContent = boton.classList.contains('activo') ? '★' : '☆';
          }

          function dibujarPin(p) {
            const icono = L.divIcon({
              className: '',
              html: '<div class="pin-tapin' + (p.esFavorito ? ' favorito' : '') + '"><span>' + p.icono + '</span></div>',
              iconSize: [34, 34],
              iconAnchor: [17, 32],
              popupAnchor: [0, -30],
            });
            const marker = L.marker([p.lat, p.lng], { icon: icono }).addTo(mapa);

            const estrellasHtml = '★'.repeat(p.estrellas) + '☆'.repeat(5 - p.estrellas);
            const contenedor = document.createElement('div');
            contenedor.className = 'popup-card';
            contenedor.innerHTML =
              '<div class="popup-nombre">' + p.nombre + '</div>' +
              '<div class="popup-cat">' + p.categoria + '</div>' +
              '<div class="popup-estrellas">' + estrellasHtml + '</div>' +
              '<div class="popup-pct">' + p.porcentaje + '% de reseñas positivas</div>' +
              (p.direccion ? '<div class="popup-dir">' + p.direccion + '</div>' : '') +
              '<div class="popup-botones"></div>';

            const botones = contenedor.querySelector('.popup-botones');
            const link = document.createElement('a');
            link.className = 'popup-link';
            link.href = p.googleUrl;
            link.target = '_blank';
            link.textContent = 'Ver en Google';
            botones.appendChild(link);

            const botonFav = document.createElement('button');
            botonFav.className = 'popup-fav' + (p.esFavorito ? ' activo' : '');
            botonFav.textContent = p.esFavorito ? '★' : '☆';
            botonFav.onclick = function () { alternarFavorito(p.slug, botonFav); };
            botones.appendChild(botonFav);

            marker.bindPopup(contenedor);
            return marker;
          }

          function pintarMapa(lista) {
            marcadores.forEach((m) => mapa.removeLayer(m));
            marcadores = lista.map(dibujarPin);
            if (capaCalor) mapa.removeLayer(capaCalor);
            const heatData = lista.map(p => [p.lat, p.lng, Math.max(0.3, Math.min(1, p.total / 50))]);
            if (heatData.length) {
              capaCalor = L.heatLayer(heatData, { radius: 45, blur: 35, maxZoom: 15 });
              capaCalor.addTo(mapa);
              capaCalor.bringToBack();
            }
          }

          function filtrar(categoria, boton) {
            const chips = document.querySelectorAll('.chip-cat');
            if (filtroActivo === categoria) {
              filtroActivo = null;
              chips.forEach((c) => c.classList.remove('activo'));
              pintarMapa(puntos);
            } else {
              filtroActivo = categoria;
              chips.forEach((c) => c.classList.toggle('activo', c === boton));
              pintarMapa(puntos.filter((p) => p.categoria === categoria));
            }
          }

          if (puntos.length === 0) {
            document.querySelector('.leyenda').style.display = 'none';
            const div = document.createElement('div');
            div.className = 'vacio';
            div.innerHTML = '<b>Todavía no hay negocios con ubicación configurada.</b>';
            document.getElementById('mapa').parentElement.appendChild(div);
          } else {
            pintarMapa(puntos);
          }
        </script>
      </body>
    </html>
  `);
});

// ---------- Dashboard de dueños: login mágico por correo, sin contraseña ----------
// Un dueño puede tener varios locales (varios slugs) — se agrupan por email.
app.get("/mis-negocios", (req, res) => {
  const codigo = (req.query.codigo || "").trim().toUpperCase();
  const codigos = leerCodigos();
  const esTarjetaNueva = codigo && codigos[codigo] && !codigos[codigo].activado;

  const bloqueActivar = `
    <form class="form-codigo" method="POST" action="/mis-negocios/ir-a-codigo">
      <input type="text" name="codigo" required placeholder="Código de activación de tu tarjeta"
             style="text-transform:uppercase;" value="${esTarjetaNueva ? codigo : ""}">
      <button type="submit">Activar tarjeta nueva</button>
    </form>`;

  const bloqueLogin = `
    <a href="/auth/google/iniciar" style="display:flex;align-items:center;justify-content:center;gap:10px;
       width:100%;box-sizing:border-box;background:#fff;border:1px solid ${MARCA.borde};border-radius:10px;
       padding:13px;font-weight:700;font-size:0.9rem;color:${MARCA.texto};text-decoration:none;margin-bottom:14px;">
      <svg width="18" height="18" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <path fill="#EA4335" d="M24 9.5c3.4 0 6.4 1.2 8.8 3.5l6.5-6.5C35.3 2.5 30 0 24 0 14.6 0 6.5 5.4 2.5 13.2l7.6 5.9C12 12.9 17.5 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-4 6.8-9.9 6.8-17.4z"/>
        <path fill="#FBBC05" d="M10.1 19.1a14.5 14.5 0 000 9.8l-7.6 5.9a24 24 0 010-21.6z"/>
        <path fill="#34A853" d="M24 48c6 0 11.3-2 15-5.4l-7.3-5.7c-2 1.4-4.6 2.2-7.7 2.2-6.5 0-12-4.4-14-10.3l-7.6 5.9C6.5 42.6 14.6 48 24 48z"/>
      </svg>
      Iniciar sesión con Google
    </a>
    <div class="divisor">o con tu correo</div>
    <form method="POST" action="/mis-negocios/solicitar">
      <input type="email" name="email" required placeholder="tu@negocio.com">
      <button type="submit">Enviarme el acceso</button>
    </form>`;

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Mis negocios — Tapin</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.verdeOscuro};
               margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
          .box{background:#fff;border-radius:18px;padding:36px 30px;max-width:380px;width:100%;text-align:center;}
          .logo{margin-bottom:24px;}
          h1{font-size:1.15rem;color:${MARCA.texto};margin:0 0 6px;}
          p{color:${MARCA.textoSuave};font-size:0.85rem;margin:0 0 22px;}
          input{width:100%;padding:14px;border:1px solid ${MARCA.borde};border-radius:10px;font-size:0.95rem;
                margin-bottom:14px;font-family:inherit;}
          button{width:100%;background:${MARCA.verde};color:#fff;border:none;padding:14px;border-radius:10px;
                 font-weight:700;font-size:0.95rem;cursor:pointer;}
          .divisor{display:flex;align-items:center;gap:10px;margin:22px 0;color:${MARCA.textoSuave};font-size:0.76rem;}
          .divisor::before,.divisor::after{content:"";flex:1;height:1px;background:${MARCA.borde};}
          .form-codigo button{background:${MARCA.oro};}
          .banner-nueva{background:${MARCA.verdeClaro};color:${MARCA.verdeOscuro};border-radius:10px;
                        padding:10px 14px;font-size:0.8rem;font-weight:600;margin-bottom:20px;}
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 38)}</div>
          ${esTarjetaNueva ? `
            <div class="banner-nueva">Detectamos tu tarjeta Tapin nueva — actívala abajo.</div>
            <h1>Activa tu tarjeta</h1>
            <p>Completa los datos de tu negocio para dejarla lista para usar.</p>
            ${bloqueActivar}
            <div class="divisor">¿Ya tienes cuenta con otra tarjeta?</div>
            <p style="margin:0 0 14px;">Inicia sesión con el correo que usaste antes:</p>
            ${bloqueLogin}
          ` : `
            <h1>Panel de tu negocio</h1>
            <p>Escribe el correo con el que registraste tu(s) tarjeta(s) Tapin. Te mandamos un link de acceso, sin contraseña que recordar — funciona también si olvidaste tu clave del panel, ahí te la recordamos.</p>
            ${bloqueLogin}
            <div class="divisor">¿Es tu primera tarjeta?</div>
            ${bloqueActivar}
          `}
        </div>
      </body>
    </html>
  `);
});

// Valida el código antes de mandarlo a /activar/:codigo, para dar un mensaje
// claro si lo escribieron mal en vez de un 404 genérico.
app.post("/mis-negocios/ir-a-codigo", (req, res) => {
  const codigo = (req.body.codigo || "").trim().toUpperCase();
  const codigos = leerCodigos();
  if (!codigo || !codigos[codigo]) {
    return res.status(404).send(
      `<p style="font-family:sans-serif;padding:40px;">Ese código no existe o está mal escrito. ` +
      `<a href="/mis-negocios">Volver a intentar</a></p>`
    );
  }
  res.redirect(`/activar/${codigo}`);
});

app.post("/mis-negocios/solicitar", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).send("Falta el correo.");

  const todos = todosLosNegocios();
  const misSlugs = Object.keys(todos).filter(
    (slug) => (todos[slug].email || "").trim().toLowerCase() === email
  );

  // Por seguridad, respondemos igual exista o no el correo (no revelamos si un
  // email está o no registrado) — pero solo mandamos el link si sí hay negocios.
  if (misSlugs.length > 0) {
    const tokens = leerTokens();

    // Limpieza: aprovechamos este momento para borrar tokens vencidos (24h)
    // de cualquier usuario, así tokens.json no crece sin control.
    const VEINTICUATRO_HORAS_MS = 24 * 60 * 60 * 1000;
    for (const t in tokens) {
      if (Date.now() - new Date(tokens[t].creado).getTime() > VEINTICUATRO_HORAS_MS) {
        delete tokens[t];
      }
    }

    const token = generarToken();
    tokens[token] = { email, creado: new Date().toISOString() };
    guardarTokens(tokens);

    const link = `${req.protocol}://${req.get("host")}/mis-negocios/${token}`;
    await enviarEmail(
      email,
      "Tu acceso a Tapin",
      `
        <div style="font-family:-apple-system,Arial,sans-serif;max-width:420px;">
          <h2 style="color:${MARCA.verdeOscuro};">Tu panel de Tapin</h2>
          <p>Toca el botón para entrar a tu panel — puedes ver todos tus negocios registrados con este correo.</p>
          <a href="${link}" style="display:inline-block;background:${MARCA.verde};color:#fff;text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:700;margin:16px 0;">Entrar a mi panel</a>
          <p style="font-size:0.8rem;color:#888;">Este link funciona por 24 horas. Si no pediste este acceso, ignora este correo.</p>
        </div>
      `
    ).catch(() => {});
  }

  res.send(`
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family:-apple-system,Arial,sans-serif;background:${MARCA.verdeOscuro};min-height:100vh;
                 display:flex;align-items:center;justify-content:center;padding:24px;margin:0;">
      <div style="background:#fff;border-radius:18px;padding:36px 30px;max-width:380px;text-align:center;">
        <h2 style="color:${MARCA.texto};">Revisa tu correo</h2>
        <p style="color:${MARCA.textoSuave};font-size:0.88rem;">Si ese correo tiene negocios registrados en Tapin, te llegó un link de acceso.</p>
      </div>
    </body></html>
  `);
});

// El link mágico en sí — muestra todos los negocios del dueño, cada uno como
// una tarjeta bonita, con acceso directo a su panel individual.
// Arma la página "Tus negocios" a partir de un correo ya verificado (por
// magic link o por Google) — reutilizada por /mis-negocios/:token y por el
// login con Google.
function renderizarPaginaNegocios(email) {
  const todos = todosLosNegocios();
  const datos = leerDatos();
  const misSlugs = Object.keys(todos).filter(
    (slug) => (todos[slug].email || "").trim().toLowerCase() === email
  );

  const tarjetas = misSlugs.map((slug) => {
    const negocio = todos[slug];
    const r = calcularResumen((datos[slug] && datos[slug].eventos) || []);
    const tokenPanel = generarLinkAccesoNegocio(slug, 7);
    return `
      <div class="card">
        <a href="/mi-panel/${slug}?key=${tokenPanel}" style="text-decoration:none;color:inherit;">
          <div class="card-top">
            <div class="card-nombre">${negocio.nombre} ${esPro(negocio) ? `<span class="badge-pro">PRO</span>` : `<span class="badge-basico">BÁSICO</span>`}</div>
            <div class="card-total">${r.total}<span>toques totales</span></div>
          </div>
          <div class="card-meta">${negocio.categoria || "—"} ${negocio.direccion ? "· " + negocio.direccion : ""}</div>
          <div class="card-cta">Ver panel completo &rarr;</div>
        </a>
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid ${MARCA.borde};font-size:0.76rem;">
          <a href="/restablecer-clave/${slug}?token=${tokenPanel}" style="color:${MARCA.verde};font-weight:600;">¿Olvidaste tu clave? Restablécela aquí →</a>
        </div>
      </div>`;
  }).join("");

  return `
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Mis negocios — Tapin</title>
        <style>
          ${ESTILO_BASE}
          .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;}
          .card{background:#fff;border:1px solid ${MARCA.borde};border-radius:16px;padding:22px;text-decoration:none;
                display:block;box-shadow:0 2px 10px rgba(0,0,0,0.03);transition:transform 0.15s;}
          .card:active{transform:scale(0.98);}
          .card-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;}
          .card-nombre{font-weight:700;font-size:1.05rem;color:${MARCA.texto};}
          .badge-pro{background:${MARCA.oro};color:#fff;font-size:0.6rem;font-weight:800;padding:2px 7px;border-radius:100px;vertical-align:middle;margin-left:4px;}
          .badge-basico{background:${MARCA.borde};color:${MARCA.textoSuave};font-size:0.6rem;font-weight:800;padding:2px 7px;border-radius:100px;vertical-align:middle;margin-left:4px;}
          .card-total{font-size:1.3rem;font-weight:700;color:${MARCA.verde};text-align:right;}
          .card-total span{display:block;font-size:0.65rem;font-weight:500;color:${MARCA.textoSuave};}
          .card-meta{color:${MARCA.textoSuave};font-size:0.8rem;margin-bottom:14px;text-transform:capitalize;}
          .card-cta{color:${MARCA.verde};font-size:0.82rem;font-weight:700;}
        </style>
      </head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div><a class="back" href="/">Inicio</a></div>
        <div class="content">
          <div class="eyebrow">Panel de dueño</div>
          <h1 class="titulo-pagina">Tus negocios</h1>
          <div class="subtitulo">${misSlugs.length} ${misSlugs.length === 1 ? "local registrado" : "locales registrados"} con este correo.</div>
          <div class="grid">${tarjetas}</div>
          ${misSlugs.length === 0 ? `
          <div class="card" style="max-width:420px;">
            <div class="card-nombre" style="margin-bottom:6px;">Todavía no tienes ningún negocio activado con este correo</div>
            <p style="color:${MARCA.textoSuave};font-size:0.85rem;margin:0 0 16px;">Si ya tienes una tarjeta física, escribe su código aquí para activarla (ahí vas a poner el nombre de tu negocio y el link de tus reseñas de Google):</p>
            <form method="POST" action="/mis-negocios/ir-a-codigo">
              <input type="text" name="codigo" required placeholder="Código de tu tarjeta"
                     style="width:100%;box-sizing:border-box;padding:12px;border:1px solid ${MARCA.borde};border-radius:9px;font-size:0.9rem;text-transform:uppercase;margin-bottom:10px;">
              <button type="submit" style="width:100%;background:${MARCA.oro};color:#fff;border:none;border-radius:9px;padding:12px;font-weight:700;font-size:0.9rem;cursor:pointer;">Activar tarjeta</button>
            </form>
          </div>
          ` : ""}
        </div>
      </body>
    </html>`;
}

// ---------- Iniciar sesión con Google (negocios) ----------
// Usa OAuth 2.0 de Google directamente (fetch a sus endpoints, sin librerías
// extra). Necesita dos variables de entorno en Render:
//   GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET — se sacan gratis en
//   console.cloud.google.com → APIs y servicios → Credenciales → Crear
//   credenciales → ID de cliente de OAuth → tipo "Aplicación web".
//   En "URI de redirección autorizados" hay que agregar (ambos dominios):
//   https://tapin.page/auth/google/callback
//   https://tapincol.com/auth/google/callback
// tipo=negocio (por defecto) o tipo=cliente — decide a quién logueamos al volver.
app.get("/auth/google/iniciar", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(500).send("El login con Google todavía no está configurado (falta GOOGLE_CLIENT_ID en Render).");
  }
  const tipo = req.query.tipo === "cliente" ? "cliente" : "negocio";
  const redirectUri = `${req.protocol}://${req.get("host")}/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    prompt: "select_account",
    state: tipo,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/auth/google/callback", async (req, res) => {
  if (!req.query.code) {
    return res.status(400).send("No llegó el código de Google. Intenta de nuevo desde /mis-negocios.");
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send("El login con Google todavía no está configurado.");
  }

  try {
    const redirectUri = `${req.protocol}://${req.get("host")}/auth/google/callback`;
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const data = await resp.json();
    if (!data.access_token) {
      console.error("[auth/google] Error obteniendo token:", JSON.stringify(data));
      return res.status(401).send("No se pudo verificar tu cuenta de Google. Intenta de nuevo.");
    }

    const infoResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const info = await infoResp.json();
    if (!info.email) {
      return res.status(401).send("Google no devolvió un correo válido.");
    }
    const email = info.email.trim().toLowerCase();

    if (req.query.state === "cliente") {
      // Cliente final: si ya existe una cuenta con este correo, entra a esa.
      // Si no existe, se crea sola — Google ya verificó el correo, así que no
      // hace falta pedirle contraseña.
      const clientes = leerClientes();
      let entrada = Object.entries(clientes).find(([, c]) => c.email === email);
      let clienteId;
      if (entrada) {
        clienteId = entrada[0];
      } else {
        clienteId = generarToken();
        clientes[clienteId] = {
          nombre: info.name || email.split("@")[0],
          email,
          salt: null,
          hash: null,
          metodoGoogle: true,
          favoritos: [],
          historial: [],
          creado: new Date().toISOString(),
        };
        guardarClientes(clientes);
      }
      iniciarSesionCliente(res, clienteId, true);
      return res.redirect("/cuenta");
    }

    res.send(renderizarPaginaNegocios(email));
  } catch (err) {
    console.error("[auth/google] Error:", err.message);
    res.status(500).send("Ocurrió un error verificando tu cuenta de Google. Intenta de nuevo.");
  }
});

app.get("/mis-negocios/:token", (req, res) => {
  const tokens = leerTokens();
  const entrada = tokens[req.params.token];
  if (!entrada) {
    return res.status(401).send("Este link no es válido o ya expiró. Solicita uno nuevo en /mis-negocios.");
  }

  // Expiración de 24 horas — un link mágico viejo ya no debe funcionar.
  const VEINTICUATRO_HORAS_MS = 24 * 60 * 60 * 1000;
  const antiguedad = Date.now() - new Date(entrada.creado).getTime();
  if (antiguedad > VEINTICUATRO_HORAS_MS) {
    delete tokens[req.params.token];
    guardarTokens(tokens);
    return res.status(401).send(
      `Este link expiró (los links de acceso duran 24 horas por seguridad). ` +
      `<a href="/mis-negocios">Solicita uno nuevo aquí</a>.`
    );
  }

  res.send(renderizarPaginaNegocios(entrada.email));
});

// ---------- Páginas de cliente: registro / login / cuenta ----------

// Página combinada de registro e inicio de sesión para clientes (personas normales).
app.get("/cliente", (req, res) => {
  const error = req.query.error;
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Mi cuenta — Tapin</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.verdeOscuro};
               margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
          .box{background:#fff;border-radius:18px;padding:32px 30px;max-width:380px;width:100%;}
          .logo{text-align:center;margin-bottom:20px;}
          .tabs{display:flex;background:${MARCA.crema};border-radius:100px;padding:4px;margin-bottom:22px;}
          .tab{flex:1;text-align:center;padding:10px;border-radius:100px;font-size:0.85rem;font-weight:700;
               cursor:pointer;color:${MARCA.textoSuave};}
          .tab.activo{background:${MARCA.verde};color:#fff;}
          .panel{display:none;}
          .panel.activo{display:block;}
          input{width:100%;padding:13px;border:1px solid ${MARCA.borde};border-radius:10px;font-size:0.92rem;
                margin-bottom:12px;font-family:inherit;}
          .campo-clave{position:relative;}
          .campo-clave input{padding-right:44px;}
          .ver-clave{position:absolute;right:4px;top:4px;bottom:4px;width:36px;background:none;border:none;
                     cursor:pointer;color:${MARCA.textoSuave};padding:0;display:flex;align-items:center;justify-content:center;}
          .ver-clave:hover{color:${MARCA.texto};}
          button{width:100%;background:${MARCA.verde};color:#fff;border:none;padding:13px;border-radius:10px;
                 font-weight:700;font-size:0.92rem;cursor:pointer;}
          .error{background:#FBEFE9;color:${MARCA.rojo};padding:10px 14px;border-radius:8px;font-size:0.82rem;margin-bottom:14px;}
          h2{font-size:1.05rem;margin:0 0 4px;color:${MARCA.texto};}
          p{color:${MARCA.textoSuave};font-size:0.82rem;margin:0 0 18px;}
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 36)}</div>
          <div class="tabs">
            <div class="tab activo" id="tab-login" onclick="mostrar('login')">Iniciar sesión</div>
            <div class="tab" id="tab-registro" onclick="mostrar('registro')">Crear cuenta</div>
          </div>
          ${error ? `<div class="error">${error === "credenciales" ? "Correo o contraseña incorrectos." : error === "existe" ? "Ya existe una cuenta con ese correo." : "Faltan datos."}</div>` : ""}

          <div class="panel activo" id="panel-login">
            <h2>Bienvenido de vuelta</h2>
            <p>Entra para ver tus favoritos y tu historial de reseñas.</p>
            <a href="/auth/google/iniciar?tipo=cliente" style="display:flex;align-items:center;justify-content:center;gap:10px;
               width:100%;box-sizing:border-box;background:#fff;border:1px solid ${MARCA.borde};border-radius:10px;
               padding:13px;font-weight:700;font-size:0.9rem;color:${MARCA.texto};text-decoration:none;margin-bottom:14px;">
              <svg width="18" height="18" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
                <path fill="#EA4335" d="M24 9.5c3.4 0 6.4 1.2 8.8 3.5l6.5-6.5C35.3 2.5 30 0 24 0 14.6 0 6.5 5.4 2.5 13.2l7.6 5.9C12 12.9 17.5 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-4 6.8-9.9 6.8-17.4z"/>
                <path fill="#FBBC05" d="M10.1 19.1a14.5 14.5 0 000 9.8l-7.6 5.9a24 24 0 010-21.6z"/>
                <path fill="#34A853" d="M24 48c6 0 11.3-2 15-5.4l-7.3-5.7c-2 1.4-4.6 2.2-7.7 2.2-6.5 0-12-4.4-14-10.3l-7.6 5.9C6.5 42.6 14.6 48 24 48z"/>
              </svg>
              Iniciar sesión con Google
            </a>
            <div style="display:flex;align-items:center;gap:10px;margin:16px 0;color:#999;font-size:0.76rem;">
              <div style="flex:1;height:1px;background:${MARCA.borde};"></div>
              o con tu correo
              <div style="flex:1;height:1px;background:${MARCA.borde};"></div>
            </div>
            <form method="POST" action="/cliente/login">
              <input type="email" name="email" required placeholder="Correo electrónico">
              <div class="campo-clave">
                <input type="password" id="clave-login" name="password" required placeholder="Contraseña">
                <button type="button" class="ver-clave" id="boton-clave-login" onclick="alternarClave('clave-login')">${ICONO_OJO_ABIERTO}</button>
              </div>
              <label style="display:flex;align-items:center;gap:8px;font-size:0.82rem;font-weight:400;margin:-6px 0 14px;cursor:pointer;">
                <input type="checkbox" name="recordar" value="si" checked style="width:auto;margin:0;">
                Mantener mi sesión iniciada
              </label>
              <button type="submit">Entrar</button>
            </form>
          </div>

          <div class="panel" id="panel-registro">
            <h2>Crea tu cuenta</h2>
            <p>Guarda tus negocios favoritos y lleva el registro de tus reseñas.</p>
            <form method="POST" action="/cliente/registro">
              <input type="text" name="nombre" required placeholder="Tu nombre">
              <input type="email" name="email" required placeholder="Correo electrónico">
              <div class="campo-clave">
                <input type="password" id="clave-registro" name="password" required minlength="6" placeholder="Contraseña (mínimo 6 caracteres)">
                <button type="button" class="ver-clave" id="boton-clave-registro" onclick="alternarClave('clave-registro')">${ICONO_OJO_ABIERTO}</button>
              </div>
              <button type="submit">Crear cuenta</button>
            </form>
          </div>
        </div>
        <script>
          function mostrar(cual) {
            document.getElementById('tab-login').className = 'tab' + (cual === 'login' ? ' activo' : '');
            document.getElementById('tab-registro').className = 'tab' + (cual === 'registro' ? ' activo' : '');
            document.getElementById('panel-login').className = 'panel' + (cual === 'login' ? ' activo' : '');
            document.getElementById('panel-registro').className = 'panel' + (cual === 'registro' ? ' activo' : '');
          }
          function alternarClave(id) {
            const campo = document.getElementById(id);
            const boton = document.getElementById('boton-clave-' + id.replace('clave-', ''));
            const oculto = campo.type === 'password';
            campo.type = oculto ? 'text' : 'password';
            boton.innerHTML = oculto ? ${JSON.stringify(ICONO_OJO_CERRADO)} : ${JSON.stringify(ICONO_OJO_ABIERTO)};
          }
        </script>
      </body>
    </html>
  `);
});

app.post("/cliente/registro", limitarIntentos(10, 15), (req, res) => {
  const nombre = (req.body.nombre || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  if (!nombre || !email || password.length < 6) {
    return res.redirect("/cliente?error=faltan");
  }

  const clientes = leerClientes();
  const yaExiste = Object.values(clientes).some((c) => c.email === email);
  if (yaExiste) {
    return res.redirect("/cliente?error=existe");
  }

  const { salt, hash } = crearHashConSal(password);
  const clienteId = generarToken();
  clientes[clienteId] = {
    nombre, email, salt, hash,
    favoritos: [],
    historial: [],
    creado: new Date().toISOString(),
  };
  guardarClientes(clientes);

  iniciarSesionCliente(res, clienteId);
  res.redirect("/cuenta");
});

app.post("/cliente/login", limitarIntentos(8, 15), (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  const recordar = req.body.recordar === "si";

  const clientes = leerClientes();
  const entrada = Object.entries(clientes).find(([, c]) => c.email === email);
  if (!entrada || !entrada[1].hash || !verificarPassword(password, entrada[1].salt, entrada[1].hash)) {
    return res.redirect("/cliente?error=credenciales");
  }

  iniciarSesionCliente(res, entrada[0], recordar);
  res.redirect("/cuenta");
});

app.get("/cliente/salir", (req, res) => {
  const cookies = leerCookies(req);
  if (cookies.tapin_sesion) {
    const sesiones = leerSesionesClientes();
    delete sesiones[cookies.tapin_sesion];
    guardarSesionesClientes(sesiones);
  }
  res.setHeader("Set-Cookie", "tapin_sesion=; HttpOnly; Secure; Path=/; Max-Age=0");
  res.redirect("/");
});

// Panel del cliente: sus favoritos y su historial de reseñas.
app.get("/cuenta", (req, res) => {
  const cliente = clienteActual(req);
  if (!cliente) return res.redirect("/cliente");

  const todos = todosLosNegocios();
  const svgCategoria = (tipo, color) => {
    const trazos = {
      restaurante: '<path d="M6 2v8M4 2v4a2 2 0 004 0V2M6 10v10M16 2c-2 2-2 5-2 7 0 1.5 1 2 2 2s2-.5 2-2c0-2 0-5-2-7zM16 21v-8"/>',
      peluqueria: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.5 8.5L20 20M8.5 15.5L20 4"/>',
      tienda: '<path d="M4 8l1-5h14l1 5M4 8h16M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8M9 12a3 3 0 006 0"/>',
      clinica: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>',
      otro: '<path d="M12 21s-7-6.5-7-11a7 7 0 0114 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    };
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.7"
                 stroke-linecap="round" stroke-linejoin="round">${trazos[tipo] || trazos.otro}</svg>`;
  };

  const favoritos = (cliente.favoritos || []).filter((slug) => todos[slug]);
  const historial = (cliente.historial || []).slice().reverse();
  const promedioDado = historial.length
    ? (historial.reduce((s, h) => s + h.valor, 0) / historial.length).toFixed(1)
    : null;

  // Idea 15: insignias simples — solo reconocimiento personal, sin competir con nadie.
  const negociosDistintos = new Set(historial.map((h) => h.slug || h.negocioNombre)).size;
  const insignias = [];
  if (historial.length >= 1) insignias.push({ texto: "Primera reseña", icono: "★" });
  if (historial.length >= 5) insignias.push({ texto: "5+ reseñas dejadas", icono: "★" });
  if (historial.length >= 20) insignias.push({ texto: "20+ reseñas dejadas", icono: "★" });
  if (favoritos.length >= 3) insignias.push({ texto: "3+ negocios favoritos", icono: "♥" });

  // Idea 24: favoritos donde hace tiempo no deja reseña (o nunca) — recordatorio suave.
  const HOY_MS = Date.now();
  const favoritosConAviso = favoritos.map((slug) => {
    const ultimaVisita = historial.find((h) => h.slug === slug);
    let diasSinVisitar = null;
    if (ultimaVisita && ultimaVisita.fechaISO) {
      diasSinVisitar = Math.floor((HOY_MS - new Date(ultimaVisita.fechaISO).getTime()) / 86400000);
    }
    return { slug, diasSinVisitar, nunca: !ultimaVisita };
  });

  // Idea 17: recomienda negocios de la misma categoría que tus favoritos, que todavía no tienes guardados.
  const categoriasFavoritas = new Set(favoritos.map((slug) => todos[slug].categoria).filter(Boolean));
  const recomendados = Object.keys(todos)
    .filter((slug) => !favoritos.includes(slug) && categoriasFavoritas.has(todos[slug].categoria))
    .slice(0, 3);

  // Zona de fidelización: recorre todos los negocios que tengan el programa
  // activo y ve si este cliente (por su correo) ya tiene sellos ahí.
  const datosGlobales = leerDatos();
  const miIdentificador = normalizarIdentificador(cliente.email);
  const misFidelizaciones = Object.keys(todos)
    .filter((slug) => todos[slug].fidelizacion)
    .map((slug) => {
      const negocio = todos[slug];
      const fid = negocio.fidelizacion;
      const registro = datosGlobales[slug] && datosGlobales[slug].fidelizacion && datosGlobales[slug].fidelizacion[miIdentificador];
      if (!registro || !registro.sellos) return null;
      return {
        slug, nombre: negocio.nombre, categoria: negocio.categoria || "otro",
        sellos: registro.sellos, meta: fid.metaSellos, premio: fid.premio,
        listo: registro.sellos >= fid.metaSellos,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.sellos / b.meta) - (a.sellos / a.meta));

  if (misFidelizaciones.some((f) => f.listo)) insignias.push({ texto: "Beneficio ganado", icono: "✓" });

  // Idea 8: avisa si el beneficio de fidelización de algún negocio cambió desde la última vez que lo vio.
  const vistosAntes = cliente.fidelizacionVista || {};
  const fidelizacionesConCambio = misFidelizaciones.map((f) => {
    const antes = vistosAntes[f.slug];
    const cambio = antes && (antes.premio !== f.premio || antes.meta !== f.meta);
    return { ...f, cambio: !!cambio };
  });
  // Actualiza lo que "ya vio" para la próxima carga (no bloquea la respuesta).
  if (misFidelizaciones.length > 0) {
    const clientes = leerClientes();
    if (clientes[cliente.id]) {
      const nuevaVista = { ...vistosAntes };
      misFidelizaciones.forEach((f) => { nuevaVista[f.slug] = { premio: f.premio, meta: f.meta }; });
      clientes[cliente.id].fidelizacionVista = nuevaVista;
      guardarClientes(clientes);
    }
  }

  const anilloProgreso = (sellos, meta, listo) => {
    const pct = Math.min(1, sellos / meta);
    const radio = 23;
    const circunferencia = 2 * Math.PI * radio;
    const offset = circunferencia * (1 - pct);
    const color = listo ? MARCA.oro : MARCA.verde;
    return `
      <svg width="56" height="56" viewBox="0 0 56 56" style="transform:rotate(-90deg);flex-shrink:0;">
        <circle cx="28" cy="28" r="${radio}" fill="none" stroke="${MARCA.borde}" stroke-width="5"/>
        <circle cx="28" cy="28" r="${radio}" fill="none" stroke="${color}" stroke-width="5"
                stroke-dasharray="${circunferencia}" stroke-dashoffset="${offset}" stroke-linecap="round"/>
      </svg>`;
  };

  const fidelizacionesHtml = fidelizacionesConCambio
    .map((f, i) => {
      const icono = svgCategoria(f.categoria, MARCA.verdeOscuro);
      const faltan = Math.max(0, f.meta - f.sellos);
      return `
        <div class="fid-card ${f.listo ? "fid-lista" : ""}" onclick="alternarFid(${i})">
          ${f.cambio ? `<div style="font-size:0.68rem;font-weight:700;color:${MARCA.verdeOscuro};margin-bottom:6px;">● Beneficio actualizado</div>` : ""}
          <div class="fid-fila">
            <div class="fid-anillo-wrap">
              ${anilloProgreso(f.sellos, f.meta, f.listo)}
              <div class="fid-anillo-centro">${icono}</div>
            </div>
            <div class="fid-info">
              <div class="fid-nombre">${f.nombre}</div>
              <div class="fid-progreso">${f.sellos} de ${f.meta} visitas registradas</div>
              ${f.listo
                ? `<div class="fid-estado fid-estado-listo">Beneficio disponible</div>`
                : `<div class="fid-estado">Faltan ${faltan} para tu beneficio</div>`}
            </div>
            <div class="fid-flecha" id="fid-flecha-${i}">⌄</div>
          </div>
          <div class="fid-detalle" id="fid-detalle-${i}">
            <div class="fid-detalle-linea"><span>Beneficio</span><b>${f.premio}</b></div>
            <div class="fid-detalle-linea"><span>Progreso</span><b>${f.sellos} / ${f.meta}</b></div>
            ${f.listo ? `<div class="fid-detalle-nota">Muéstrale esta pantalla al negocio para reclamarlo.</div>` : ""}
          </div>
        </div>`;
    })
    .join("");

  const favoritosHtml = favoritos
    .map((slug) => {
      const n = todos[slug];
      const icono = svgCategoria(n.categoria, MARCA.verdeOscuro);
      const aviso = favoritosConAviso.find((f) => f.slug === slug);
      let textoAviso = "";
      if (aviso && aviso.nunca) textoAviso = "Todavía no lo has calificado";
      else if (aviso && aviso.diasSinVisitar !== null && aviso.diasSinVisitar >= 30) textoAviso = `Hace ${aviso.diasSinVisitar} días no lo calificas`;
      return `
        <div class="fav-card">
          <div class="fav-icono">${icono}</div>
          <div class="fav-info">
            <div class="fav-nombre">${n.nombre}</div>
            <div class="fav-cat">${n.categoria || "negocio"} ${n.direccion ? "· " + n.direccion : ""}</div>
            ${textoAviso ? `<div class="fav-aviso">${textoAviso}</div>` : ""}
          </div>
          <div class="fav-acciones">
            <a href="#" onclick="compartir('${(n.nombre || "").replace(/'/g, "")}','${n.googleUrl}');return false;" title="Compartir">⤴</a>
            <a href="${n.googleUrl}" target="_blank" title="Ver en Google">↗</a>
            <a href="#" onclick="quitar('${slug}');return false;" class="quitar" title="Quitar de favoritos">✕</a>
          </div>
        </div>`;
    }).join("");

  const recomendadosHtml = recomendados
    .map((slug) => {
      const n = todos[slug];
      return `<div class="reco-card">
        <div class="reco-nombre">${n.nombre}</div>
        <div class="reco-cat">${n.categoria || "negocio"}</div>
        <a href="/descubre">Ver en el mapa →</a>
      </div>`;
    }).join("");

  const insigniasHtml = insignias
    .map((ins) => `<div class="insignia"><span>${ins.icono}</span>${ins.texto}</div>`)
    .join("");

  // Idea 9: mini-mapa — solo los favoritos que tengan ubicación configurada.
  const favoritosConMapa = favoritos
    .filter((slug) => todos[slug].lat != null && todos[slug].lng != null)
    .map((slug) => ({ nombre: todos[slug].nombre, lat: todos[slug].lat, lng: todos[slug].lng }));

  // Idea 25: lista de favoritos compartible públicamente (opt-in).
  const compartirActivo = !!cliente.compartirFavoritos;



  const historialHtml = historial
    .map((h, i) => {
      const color = h.valor >= 4 ? MARCA.verde : h.valor === 3 ? MARCA.oro : MARCA.rojo;
      const indiceOriginal = historial.length - 1 - i; // historial ya está invertido; esto lo devuelve al índice real
      return `
        <div class="linea-item" data-nombre="${(h.negocioNombre || "").toLowerCase()}">
          <div class="linea-punto" style="background:${color};"></div>
          <div class="linea-contenido">
            <div class="linea-top">
              <b>${h.negocioNombre}</b>
              <span class="linea-estrellas" style="color:${MARCA.oro};">${"★".repeat(h.valor)}${"☆".repeat(5 - h.valor)}</span>
            </div>
            <div class="linea-fecha">${h.fecha}
              <a href="#" onclick="borrarHistorial(${indiceOriginal});return false;" style="color:${MARCA.rojo};font-weight:600;margin-left:8px;">Borrar</a>
            </div>
          </div>
        </div>`;
    }).join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Mi cuenta — Tapin</title>
        <style>
          ${ESTILO_BASE}
          .content{max-width:640px;}
          .hero-cuenta{background:linear-gradient(135deg, ${MARCA.verdeOscuro} 0%, #0F5132 100%);
                       border-radius:20px;padding:32px 28px;color:#fff;margin-bottom:28px;position:relative;overflow:hidden;}
          .hero-cuenta::before{content:"";position:absolute;top:-40%;right:-15%;width:220px;height:220px;
                                border-radius:50%;background:radial-gradient(circle, rgba(201,162,75,0.35), transparent 70%);}
          .hero-saludo{font-size:1.5rem;font-weight:800;position:relative;}
          .hero-email{color:#CFE3D8;font-size:0.85rem;margin-top:2px;position:relative;}
          .hero-stats{display:flex;gap:12px;margin-top:22px;position:relative;flex-wrap:wrap;}
          .hero-stat{background:rgba(255,255,255,0.12);border-radius:14px;padding:12px 16px;flex:1;min-width:96px;}
          .hero-stat-num{font-size:1.4rem;font-weight:800;}
          .hero-stat-lbl{font-size:0.66rem;color:#CFE3D8;text-transform:uppercase;letter-spacing:0.04em;margin-top:2px;}

          .seccion-titulo{font-size:1.05rem;font-weight:800;margin:32px 0 14px;color:${MARCA.texto};
                           display:flex;align-items:center;gap:8px;}

          .fav-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;padding:16px;
                    display:flex;align-items:center;gap:14px;margin-bottom:10px;transition:box-shadow .15s,transform .15s;}
          .fav-card:hover{box-shadow:0 6px 18px rgba(11,61,44,0.08);transform:translateY(-1px);}
          .fav-icono{width:42px;height:42px;border-radius:11px;background:${MARCA.verdeClaro};display:flex;
                     align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0;}
          .fav-info{flex:1;min-width:0;}
          .fav-nombre{font-weight:700;font-size:0.95rem;}
          .fav-cat{color:${MARCA.textoSuave};font-size:0.78rem;text-transform:capitalize;}
          .fav-acciones{display:flex;gap:6px;flex-shrink:0;}
          .fav-acciones a{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;
                          text-decoration:none;font-size:0.9rem;background:${MARCA.crema};color:${MARCA.texto};}
          .fav-acciones .quitar{color:${MARCA.rojo};}
          .fav-acciones a:hover{background:${MARCA.verdeClaro};}

          .linea{position:relative;padding-left:6px;}
          .linea-item{position:relative;padding:0 0 20px 26px;}
          .linea-item::before{content:"";position:absolute;left:5px;top:14px;bottom:-6px;width:1.5px;background:${MARCA.borde};}
          .linea-item:last-child::before{display:none;}
          .linea-punto{position:absolute;left:0;top:3px;width:11px;height:11px;border-radius:50%;box-shadow:0 0 0 3px #fff;}
          .linea-contenido{background:#fff;border:1px solid ${MARCA.borde};border-radius:12px;padding:12px 16px;}
          .linea-top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;}
          .linea-estrellas{font-size:0.85rem;white-space:nowrap;}
          .linea-fecha{color:${MARCA.textoSuave};font-size:0.74rem;margin-top:2px;}

          .vacio-msg{color:${MARCA.textoSuave};font-size:0.86rem;background:#fff;padding:26px 22px;border-radius:14px;
                     border:1.5px dashed ${MARCA.borde};text-align:center;}
          .vacio-msg .vacio-icono{font-size:1.8rem;margin-bottom:8px;display:block;}
          .vacio-msg a{color:${MARCA.verde};font-weight:700;}

          .fid-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;}
          .fid-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;padding:16px;
                    cursor:pointer;transition:border-color .15s,box-shadow .15s;}
          .fid-card:hover{box-shadow:0 4px 16px rgba(11,61,44,0.07);}
          .fid-card.fid-lista{border-color:${MARCA.oro};border-width:1.5px;}
          .fid-fila{display:flex;align-items:center;gap:14px;}
          .fid-anillo-wrap{position:relative;width:56px;height:56px;flex-shrink:0;}
          .fid-anillo-centro{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:1.1rem;}
          .fid-info{min-width:0;flex:1;}
          .fid-nombre{font-weight:700;font-size:0.9rem;color:${MARCA.texto};}
          .fid-progreso{font-size:0.74rem;color:${MARCA.textoSuave};margin-top:1px;}
          .fid-estado{font-size:0.72rem;color:${MARCA.verdeOscuro};font-weight:600;margin-top:4px;}
          .fid-estado-listo{color:#8A6300;}
          .fid-flecha{color:${MARCA.textoSuave};font-size:0.9rem;transition:transform .2s;flex-shrink:0;}
          .fid-card.abierta .fid-flecha{transform:rotate(180deg);}
          .fid-detalle{max-height:0;overflow:hidden;transition:max-height .25s ease;}
          .fid-card.abierta .fid-detalle{max-height:120px;margin-top:14px;padding-top:14px;border-top:1px solid ${MARCA.borde};}
          .fid-detalle-linea{display:flex;justify-content:space-between;font-size:0.78rem;color:${MARCA.textoSuave};padding:3px 0;}
          .fid-detalle-linea b{color:${MARCA.texto};}
          .fid-detalle-nota{font-size:0.74rem;color:#8A6300;margin-top:8px;font-weight:600;}

          .top-acciones{display:flex;justify-content:flex-end;gap:8px;margin-bottom:10px;}
          .icono-toggle{width:34px;height:34px;border-radius:50%;background:#fff;border:1px solid ${MARCA.borde};
                        display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:0.95rem;}

          .insignias-fila{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:26px;}
          .insignia{background:#fff;border:1px solid ${MARCA.borde};border-radius:100px;padding:6px 14px;
                    font-size:0.76rem;font-weight:600;color:${MARCA.texto};display:flex;align-items:center;gap:6px;}
          .insignia span{color:${MARCA.oro};}

          .fav-aviso{font-size:0.7rem;color:${MARCA.oro};font-weight:600;margin-top:3px;}

          .buscar-caja{margin-bottom:14px;}
          .buscar-caja input{width:100%;box-sizing:border-box;padding:10px 14px;border:1px solid ${MARCA.borde};
                              border-radius:10px;font-size:0.85rem;}

          .reco-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:26px;}
          .reco-card{background:#fff;border:1px dashed ${MARCA.borde};border-radius:12px;padding:14px;}
          .reco-nombre{font-weight:700;font-size:0.85rem;}
          .reco-cat{color:${MARCA.textoSuave};font-size:0.72rem;text-transform:capitalize;margin-bottom:6px;}
          .reco-card a{font-size:0.76rem;color:${MARCA.verde};font-weight:700;text-decoration:none;}

          #mini-mapa{height:180px;border-radius:14px;margin-bottom:26px;border:1px solid ${MARCA.borde};}

          .compartir-caja{background:#fff;border:1px solid ${MARCA.borde};border-radius:12px;padding:16px;
                          margin-bottom:26px;font-size:0.82rem;}
          .compartir-caja label{display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer;}
          .compartir-caja input{width:auto;}
          .compartir-link{margin-top:8px;font-size:0.78rem;color:${MARCA.verde};word-break:break-all;}

          /* Idea 18: modo oscuro — solo afecta esta página, no el resto del sitio. */
          body.modo-oscuro{background:#15201B;}
          body.modo-oscuro .hero-cuenta{background:linear-gradient(135deg,#0A2A1E,#0F3325);}
          body.modo-oscuro .seccion-titulo{color:#E9EDE9;}
          body.modo-oscuro .fav-card, body.modo-oscuro .fid-card, body.modo-oscuro .linea-contenido,
          body.modo-oscuro .reco-card, body.modo-oscuro .compartir-caja, body.modo-oscuro .insignia,
          body.modo-oscuro .icono-toggle, body.modo-oscuro .vacio-msg, body.modo-oscuro .buscar-caja input{
            background:#1E2B24;border-color:#324137;color:#D8E0DA;}
          body.modo-oscuro .fav-nombre, body.modo-oscuro .fid-nombre, body.modo-oscuro .linea-top b,
          body.modo-oscuro .reco-nombre{color:#F2F5F2;}
          body.modo-oscuro .hero-stat{background:rgba(255,255,255,0.08);}

          /* Idea 26: accesibilidad — texto más grande y más contraste. */
          body.accesible{font-size:112%;}
          body.accesible .fav-cat, body.accesible .linea-fecha, body.accesible .fid-progreso{color:${MARCA.texto} !important;}
        </style>
      </head>
      <body id="body-cuenta">
        <div class="topbar">
          <div>${logoSvg("#FFFFFF", 30)}</div>
          <a class="back" href="/cliente/salir">Cerrar sesión</a>
        </div>
        <div class="content">
          <div class="top-acciones">
            <div class="icono-toggle" id="btn-oscuro" onclick="alternarOscuro()" title="Modo oscuro">◐</div>
            <div class="icono-toggle" id="btn-accesible" onclick="alternarAccesible()" title="Texto más grande">A+</div>
          </div>

          <div class="hero-cuenta">
            <div class="hero-saludo">Hola, ${escaparHtml(cliente.nombre.split(" ")[0])}</div>
            <div class="hero-email">${cliente.email}</div>
            <div class="hero-stats">
              <div class="hero-stat"><div class="hero-stat-num">${favoritos.length}</div><div class="hero-stat-lbl">Favoritos</div></div>
              <div class="hero-stat"><div class="hero-stat-num">${historial.length}</div><div class="hero-stat-lbl">Reseñas</div></div>
              ${promedioDado ? `<div class="hero-stat"><div class="hero-stat-num">${promedioDado}★</div><div class="hero-stat-lbl">Promedio dado</div></div>` : ""}
            </div>
          </div>

          ${insigniasHtml ? `<div class="insignias-fila">${insigniasHtml}</div>` : ""}

          ${misFidelizaciones.length > 0 ? `
          <div class="seccion-titulo">Fidelización</div>
          <div class="fid-grid">${fidelizacionesHtml}</div>
          ` : ""}

          <div class="seccion-titulo">Tus negocios favoritos</div>
          ${favoritosConMapa.length > 0 ? `<div id="mini-mapa"></div>` : ""}
          ${favoritosHtml || `<div class="vacio-msg">Todavía no has guardado ningún negocio.<br><a href="/descubre">Explora el mapa de negocios →</a></div>`}

          ${recomendadosHtml ? `
          <div class="seccion-titulo">Basado en tus favoritos</div>
          <div class="reco-grid">${recomendadosHtml}</div>
          ` : ""}

          ${favoritos.length > 0 ? `
          <div class="compartir-caja">
            <label><input type="checkbox" id="check-compartir" ${compartirActivo ? "checked" : ""} onchange="alternarCompartir(this.checked)"> Hacer pública mi lista de favoritos (link para compartir)</label>
            ${compartirActivo ? `<div class="compartir-link">${req.protocol}://${req.get("host")}/perfil/${cliente.id}</div>` : ""}
          </div>
          ` : ""}

          <div class="seccion-titulo">Tu historial de reseñas</div>
          ${historial.length ? `
          <div class="buscar-caja"><input type="text" id="buscar-historial" placeholder="Buscar en tu historial..." oninput="filtrarHistorial(this.value)"></div>
          <div class="linea" id="lista-historial">${historialHtml}</div>
          ` : `<div class="vacio-msg">Todavía no has calificado ningún negocio con Tapin.</div>`}
        </div>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <script>
          async function quitar(slug) {
            await fetch('/favoritos/' + slug + '/quitar', { method: 'POST' });
            location.reload();
          }
          function alternarFid(i) {
            document.getElementById('fid-detalle-' + i).parentElement.classList.toggle('abierta');
          }

          // Idea 7: borrar una entrada de tu historial personal.
          async function borrarHistorial(i) {
            if (!confirm('¿Borrar esta reseña de tu historial? Esto no borra tu reseña real en Google, solo tu registro en Tapin.')) return;
            await fetch('/historial/' + i + '/borrar', { method: 'POST' });
            location.reload();
          }

          // Idea 6: buscar dentro de tu historial, sin recargar la página.
          function filtrarHistorial(texto) {
            const t = texto.toLowerCase();
            document.querySelectorAll('#lista-historial .linea-item').forEach((el) => {
              el.style.display = el.dataset.nombre.includes(t) ? '' : 'none';
            });
          }

          // Idea 10: compartir un favorito (usa el share nativo del celular si existe).
          function compartir(nombre, url) {
            if (navigator.share) {
              navigator.share({ title: nombre, text: 'Mira este lugar en Tapin: ' + nombre, url: url });
            } else {
              navigator.clipboard.writeText(url);
              alert('Link copiado — pégalo donde quieras compartirlo.');
            }
          }

          // Idea 25: activar/desactivar la lista pública de favoritos.
          async function alternarCompartir(activo) {
            await fetch('/cuenta/compartir-favoritos', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ activo }),
            });
            location.reload();
          }

          // Idea 18: modo oscuro, guardado en este mismo navegador.
          function alternarOscuro() {
            document.body.classList.toggle('modo-oscuro');
            localStorage.setItem('tapin_oscuro', document.body.classList.contains('modo-oscuro') ? '1' : '0');
          }
          if (localStorage.getItem('tapin_oscuro') === '1') document.body.classList.add('modo-oscuro');

          // Idea 26: accesibilidad — texto más grande, guardado en este navegador.
          function alternarAccesible() {
            document.body.classList.toggle('accesible');
            localStorage.setItem('tapin_accesible', document.body.classList.contains('accesible') ? '1' : '0');
          }
          if (localStorage.getItem('tapin_accesible') === '1') document.body.classList.add('accesible');

          // Idea 9: mini-mapa de tus favoritos con ubicación configurada.
          const favoritosMapa = ${JSON.stringify(favoritosConMapa)};
          if (favoritosMapa.length > 0) {
            const centro = favoritosMapa[0];
            const mm = L.map('mini-mapa', { zoomControl: false, dragging: true, scrollWheelZoom: false })
              .setView([centro.lat, centro.lng], 12);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '' }).addTo(mm);
            favoritosMapa.forEach((p) => L.marker([p.lat, p.lng]).addTo(mm).bindPopup(p.nombre));
          }
        </script>
      </body>
    </html>
  `);
});

// Idea 7: borra una entrada de TU historial personal en Tapin (el registro
// interno que ves en tu cuenta) — no borra ni modifica la reseña real que
// quedó publicada en Google, eso Tapin no lo puede tocar.
app.post("/historial/:i/borrar", (req, res) => {
  const cliente = clienteActual(req);
  if (!cliente) return res.status(401).json({ ok: false });
  const i = parseInt(req.params.i, 10);
  const clientes = leerClientes();
  if (clientes[cliente.id] && clientes[cliente.id].historial && clientes[cliente.id].historial[i]) {
    clientes[cliente.id].historial.splice(i, 1);
    guardarClientes(clientes);
  }
  res.json({ ok: true });
});

// Idea 25: activa o desactiva que tu lista de favoritos sea visible en un link público.
app.post("/cuenta/compartir-favoritos", (req, res) => {
  const cliente = clienteActual(req);
  if (!cliente) return res.status(401).json({ ok: false });
  const clientes = leerClientes();
  if (clientes[cliente.id]) {
    clientes[cliente.id].compartirFavoritos = !!req.body.activo;
    guardarClientes(clientes);
  }
  res.json({ ok: true });
});

// Página pública (solo si el cliente activó "compartir mi lista") con sus
// favoritos — para mandarle el link a un amigo.
app.get("/perfil/:clienteId", (req, res) => {
  const clientes = leerClientes();
  const cliente = clientes[req.params.clienteId];
  if (!cliente || !cliente.compartirFavoritos) {
    return res.status(404).send("Este perfil no existe o no está compartido públicamente.");
  }
  const todos = todosLosNegocios();
  const favoritos = (cliente.favoritos || []).filter((slug) => todos[slug]);

  const filas = favoritos
    .map((slug) => {
      const n = todos[slug];
      return `<div class="fav-card">
        <div class="fav-info">
          <div class="fav-nombre">${n.nombre}</div>
          <div class="fav-cat">${n.categoria || "negocio"} ${n.direccion ? "· " + n.direccion : ""}</div>
        </div>
        <a href="${n.googleUrl}" target="_blank" style="color:${MARCA.verde};font-weight:700;font-size:0.8rem;">Ver en Google →</a>
      </div>`;
    }).join("");

  res.send(`
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Favoritos de ${escaparHtml(cliente.nombre.split(" ")[0])} — Tapin</title>
    <style>
      ${ESTILO_BASE}
      .fav-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;padding:16px;
                display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:10px;}
      .fav-nombre{font-weight:700;font-size:0.95rem;}
      .fav-cat{color:${MARCA.textoSuave};font-size:0.78rem;text-transform:capitalize;}
    </style></head>
    <body>
      <div class="topbar"><div>${logoSvg("#FFFFFF", 30)}</div></div>
      <div class="content">
        <div class="eyebrow">Lista pública</div>
        <h1 class="titulo-pagina">Favoritos de ${escaparHtml(cliente.nombre.split(" ")[0])}</h1>
        <div class="subtitulo">Negocios recomendados en Tapin</div>
        ${filas || "<p>Todavía no tiene negocios favoritos guardados.</p>"}
      </div>
    </body></html>
  `);
});

// Guarda o quita un negocio de favoritos — requiere sesión de cliente.
app.post("/favoritos/:slug/guardar", (req, res) => {
  const cliente = clienteActual(req);
  if (!cliente) return res.status(401).json({ ok: false, motivo: "No has iniciado sesión." });

  const clientes = leerClientes();
  if (!clientes[cliente.id].favoritos) clientes[cliente.id].favoritos = [];
  if (!clientes[cliente.id].favoritos.includes(req.params.slug)) {
    clientes[cliente.id].favoritos.push(req.params.slug);
    guardarClientes(clientes);
  }
  res.json({ ok: true });
});

app.post("/favoritos/:slug/quitar", (req, res) => {
  const cliente = clienteActual(req);
  if (!cliente) return res.status(401).json({ ok: false, motivo: "No has iniciado sesión." });

  const clientes = leerClientes();
  clientes[cliente.id].favoritos = (clientes[cliente.id].favoritos || []).filter((s) => s !== req.params.slug);
  guardarClientes(clientes);
  res.json({ ok: true });
});


// algo falla (antes era difícil saber por qué un correo no llegaba). Bórrala o
// no la uses en producción si te preocupa que alguien la descubra — está protegida
// con ADMIN_KEY de todas formas.
// Visítalo así: https://tu-dominio.com/test-email?key=TU_CLAVE&to=tu@correo.com
app.get("/test-email", limitarIntentosAdmin, async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const destino = req.query.to;
  if (!destino) return res.status(400).send("Agrega &to=tu@correo.com a la URL.");

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return res.status(400).send(
      "Faltan las variables de entorno EMAIL_USER y/o EMAIL_PASS en Render. " +
      "Ve a tu servicio en Render → Environment → agrégalas, y vuelve a intentar."
    );
  }

  const resultado = await enviarEmail(
    destino,
    "Correo de prueba — Tapin",
    `<p>Si ves esto, el envío de correos está funcionando correctamente.</p>
     <p style="color:#888;font-size:0.85rem;">Enviado desde /test-email el ${new Date().toLocaleString("es-CO")}</p>`
  );

  if (resultado.ok) {
    res.send(`Correo enviado a ${destino}. Revisa la bandeja de entrada (y spam).`);
  } else {
    res.status(500).send(`❌ Falló el envío. Motivo exacto: ${resultado.motivo}`);
  }
});

app.get("/", (req, res) => {
  res.send(`
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Tapin — Convierte cada visita en una reseña de Google</title>
        <meta name="description" content="Tapin: tarjeta NFC para negocios en Colombia que aumenta las reseñas de Google en segundos. Gestión de reputación online — las calificaciones negativas se quedan en privado, nunca se publican.">
        <meta name="google-site-verification" content="H7LUjIzom1urhBIS-T8yWBsUl1T2-o6NBbVAiEZf-Nw" />
        <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230d432b'/%3E%3Ctext x='32' y='46' text-anchor='middle' font-family='Arial,sans-serif' font-size='42' font-weight='700' fill='%23fbf6e9'%3ET%3C/text%3E%3C/svg%3E">
        <meta property="og:title" content="Tapin — Convierte cada visita en una reseña de Google">
        <meta property="og:description" content="Tarjeta NFC para negocios en Colombia: aumenta tus reseñas de Google y protege tu reputación online. Lo negativo se queda en privado, nunca se publica.">
        <meta property="og:type" content="website">
        <meta property="og:url" content="https://tapincol.com">
        <meta property="og:locale" content="es_CO">
        <meta name="twitter:card" content="summary">
        <meta name="twitter:title" content="Tapin — Convierte cada visita en una reseña de Google">
        <meta name="twitter:description" content="Tarjeta NFC para negocios: un toque y tus clientes te dejan reseña en Google.">
        <link rel="canonical" href="https://tapincol.com">
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600;1,700&display=swap" rel="stylesheet">
        <style>
          *{box-sizing:border-box;}
          :root{--ink:#062e1e;--forest:#0d432b;--forest2:#146542;--cream:#fbf6e9;--paper:#fffefd;--muted:#50695b;--line:#dedccc;--gold:#e8a623;--gold2:#f3d576;}
          body{font-family:'DM Sans','Segoe UI',sans-serif;background:var(--cream);color:var(--ink);margin:0;line-height:1.5;}
          a{color:inherit;}

          .site-header{height:76px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 max(24px,calc((100vw - 1120px)/2));background:rgba(251,246,233,.94);position:sticky;top:0;z-index:10;backdrop-filter:blur(10px);}
          .site-brand{display:flex;align-items:center;}
          .site-nav{display:flex;gap:32px;align-items:center;}
          .site-nav a{font-size:.88rem;color:var(--ink);text-decoration:none;font-weight:500;}
          .site-order{background:var(--forest);color:#fff!important;padding:12px 20px;border-radius:999px;font-weight:700!important;}

          .hero{background:linear-gradient(155deg,var(--forest2) 0%,var(--forest) 45%,#082c1c 100%);color:#fff;padding:80px 24px 60px;text-align:center;position:relative;overflow:hidden;}
          .hero::before{content:"";position:absolute;top:-20%;left:8%;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,rgba(232,166,35,.35),transparent 70%);}
          .hero::after{content:"";position:absolute;bottom:-25%;right:5%;width:380px;height:380px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.12),transparent 70%);}
          .hero-kicker{font-size:.72rem;font-weight:800;letter-spacing:.12em;color:var(--gold2);position:relative;z-index:1;}
          .hero h1{font-family:'Playfair Display',Georgia,serif;font-size:clamp(2.4rem,5vw,4rem);letter-spacing:-.03em;margin:16px auto 14px;max-width:680px;position:relative;z-index:1;line-height:1.05;}
          .hero p{color:#CFE3D8;font-size:1.08rem;max-width:520px;margin:0 auto;position:relative;z-index:1;}
          .hero-cta-row{display:flex;gap:14px;justify-content:center;margin-top:30px;position:relative;z-index:1;flex-wrap:wrap;}
          .hero-cta-row a{border-radius:999px;padding:15px 26px;text-decoration:none;font-weight:700;font-size:.92rem;}
          .hero-cta-main{background:var(--gold);color:var(--ink);box-shadow:0 14px 26px rgba(232,166,35,.3);}
          .hero-cta-alt{border:1.5px solid rgba(255,255,255,.5);color:#fff;}

          .tarjeta-wrap{margin:52px auto 8px;height:230px;display:flex;align-items:center;justify-content:center;position:relative;z-index:1;}
          .tarjeta-nfc{width:210px;height:210px;border-radius:22px;position:relative;background:#FFFFFF;box-shadow:0 30px 60px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08);animation:flotar 4.5s ease-in-out infinite;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;}
          .tarjeta-logo{position:absolute;top:18px;left:22px;font-size:1.05rem;font-weight:800;letter-spacing:-0.02em;color:${MARCA.texto};}
          .tarjeta-nfc-icono{position:absolute;top:18px;right:20px;width:22px;height:22px;opacity:0.7;}
          .tarjeta-google{font-size:1.6rem;font-weight:700;letter-spacing:-0.01em;margin-top:6px;}
          .tarjeta-google span:nth-child(1){color:#4285F4;}
          .tarjeta-google span:nth-child(2){color:#EA4335;}
          .tarjeta-google span:nth-child(3){color:#FBBC05;}
          .tarjeta-google span:nth-child(4){color:#4285F4;}
          .tarjeta-google span:nth-child(5){color:#34A853;}
          .tarjeta-google span:nth-child(6){color:#EA4335;}
          .tarjeta-estrellas{color:${MARCA.oro};font-size:1.05rem;letter-spacing:2px;margin:6px 0 8px;}
          .tarjeta-texto{font-size:0.68rem;color:${MARCA.textoSuave};text-align:center;line-height:1.3;margin-bottom:10px;}
          .tarjeta-mano{width:26px;height:26px;opacity:0.75;}
          @keyframes flotar{0%{transform:translateY(0) rotate(-4deg);}50%{transform:translateY(-16px) rotate(2deg);}100%{transform:translateY(0) rotate(-4deg);}}
          @media (prefers-reduced-motion: reduce){.tarjeta-nfc{animation:none;}}

          .contenido{max-width:1080px;margin:0 auto;padding:90px 24px;}
          .stats-strip{display:grid;grid-template-columns:repeat(3,1fr);background:var(--paper);border:1px solid var(--line);border-radius:24px;box-shadow:0 12px 26px rgba(9,49,30,.06);margin-bottom:110px;}
          .stats-strip div{text-align:center;padding:27px 16px;border-right:1px solid var(--line);}
          .stats-strip div:last-child{border-right:none;}
          .stats-strip strong{display:block;font-size:2rem;font-family:'Playfair Display',Georgia,serif;color:var(--ink);}
          .stats-strip span{font-size:.82rem;color:var(--muted);}

          .seccion-titulo{font-family:'Playfair Display',Georgia,serif;font-size:clamp(2.2rem,4vw,3.4rem);line-height:1.03;letter-spacing:-.05em;text-align:center;margin:0 0 16px;color:var(--ink);}
          .seccion-sub{text-align:center;color:var(--muted);max-width:560px;margin:0 auto 50px;font-size:1rem;}

          #como-funciona,#accesos,#precios,.faq{padding:68px 40px;border-radius:34px;margin-bottom:76px;}
          #como-funciona,#precios{background:rgba(255,255,255,.42);border:1px solid rgba(222,220,204,.75);}
          #accesos{background:rgba(232,239,230,.62);border:1px solid rgba(202,218,202,.8);}
          .faq{background:rgba(247,239,214,.58);border:1px solid rgba(226,208,158,.7);max-width:none;}
          #accesos .accesos{margin-bottom:0;}

          .flujo{border-radius:28px;padding:34px 30px;margin-bottom:28px;}
          .flujo-basico{background:#edf2ed;border:1px solid #d5e1d7;}
          .flujo-pro{background:linear-gradient(135deg,#fff 35%,#f9f1dd);border:2px solid var(--gold);box-shadow:0 16px 30px rgba(139,96,12,.1);}
          .flujo-cabecera{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px;}
          .flujo-cabecera h3{font-family:'Playfair Display',Georgia,serif;font-size:1.65rem;margin:0;color:var(--ink);}
          .flujo-etiqueta{font-size:.66rem;font-weight:900;letter-spacing:.07em;padding:6px 11px;border-radius:999px;text-transform:uppercase;background:var(--paper);color:var(--forest);}
          .flujo-pro .flujo-etiqueta{background:var(--forest);color:#fff;}
          .flujo-descripcion{color:var(--muted);font-size:.9rem;margin:0 0 24px;}
          .pasos{display:flex;flex-wrap:wrap;gap:16px;margin:0;}
          .paso{flex:1;min-width:230px;background:var(--paper);border:1px solid var(--line);border-radius:22px;padding:30px 26px;box-shadow:0 10px 20px rgba(9,49,30,.05);}
          .paso.paso-pro{border:1px solid #e6c774;background:var(--paper);position:relative;}
          .paso-pro-badge{position:absolute;right:18px;top:18px;background:var(--forest);color:#fff;font-size:.62rem;font-weight:900;letter-spacing:.06em;padding:6px 10px;border-radius:999px;text-transform:uppercase;}
          .paso-num{width:38px;height:38px;border-radius:50%;background:#edf1ed;color:var(--forest);font-size:.8rem;font-weight:800;display:flex;align-items:center;justify-content:center;margin-bottom:18px;}
          .paso h3{font-family:'Playfair Display',Georgia,serif;font-size:1.25rem;margin:0 0 8px;color:var(--ink);}
          .paso p{font-size:.88rem;color:var(--muted);line-height:1.55;margin:0;}

          .accesos{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:1fr;gap:18px;margin-bottom:110px;align-items:stretch;}
          .acceso{border-radius:24px;padding:32px 28px;text-decoration:none;color:var(--ink);position:relative;overflow:hidden;box-shadow:0 14px 28px rgba(9,49,30,.08);transition:transform .2s ease,box-shadow .2s ease;min-height:240px;height:100%;display:flex;flex-direction:column;align-self:stretch;}
          .acceso:hover{transform:translateY(-6px);box-shadow:0 22px 40px rgba(9,49,30,.16);}
          .acceso-1{background:linear-gradient(135deg,#0a3e29,#146542);color:#fff;}
          .acceso-2{background:linear-gradient(145deg,#fffef8,#fbf1d8);border:2px solid var(--gold);}
          .acceso-3{background:var(--paper);border:1px solid var(--line);}
          .acceso-4{background:linear-gradient(135deg,#f3d576,#e8a623);color:var(--ink);}
          .acceso-badge{position:absolute;right:18px;top:18px;font-size:.62rem;font-weight:900;letter-spacing:.08em;padding:6px 10px;border-radius:999px;}
          .acceso-1 .acceso-badge{background:var(--gold);color:var(--ink);}
          .acceso-2 .acceso-badge{background:var(--forest);color:#fff;}
          .acceso-icono{font-size:1.4rem;margin-bottom:20px;}
          .acceso h3{font-family:'Playfair Display',Georgia,serif;font-size:1.5rem;margin:0 0 8px;}
          .acceso p{font-size:.86rem;line-height:1.5;margin:0;opacity:.85;}
          .acceso-flecha{margin-top:auto;padding-top:20px;font-weight:800;font-size:.88rem;}

          .planes{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:44px;}
          .plan{flex:1;min-width:280px;border:1px solid var(--line);border-radius:28px;padding:38px 40px;box-shadow:0 12px 24px rgba(9,49,30,.06);background:var(--paper);position:relative;}
          .plan.pro{background:linear-gradient(135deg,#fff 40%,#f9f1dd);border:2px solid var(--gold);}
          .plan-badge{position:absolute;top:26px;right:28px;background:var(--forest);color:#fff;font-size:.66rem;font-weight:800;padding:6px 12px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em;}
          .plan-nombre{font-size:.8rem;font-weight:700;color:#526f5e;text-transform:uppercase;letter-spacing:.03em;}
          .plan-precio{font-family:'Playfair Display',Georgia,serif;color:var(--ink);font-size:2.8rem;letter-spacing:-.05em;margin-top:6px;}
          .plan-precio span{font-family:'DM Sans',sans-serif;font-size:.95rem;font-weight:500;color:var(--muted);}
          .plan-anual{background:#f4f6ef;border:2px solid var(--forest);border-radius:12px;padding:14px 18px;margin:16px 0;display:flex;justify-content:space-between;align-items:center;gap:10px;}
          .plan-anual-etiqueta{font-size:.66rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);}
          .plan-anual-precio{font-weight:800;color:var(--ink);}
          .plan-anual-badge{background:var(--gold);color:var(--ink);font-size:.68rem;font-weight:800;padding:5px 10px;border-radius:999px;white-space:nowrap;}
          .plan ul{list-style:none;margin:18px 0 0;padding:0;}
          .plan li{padding:9px 0;border-top:1px solid #e9e9e2;font-size:.88rem;display:flex;gap:8px;}
          .plan li:first-child{border-top:none;}
          .check{color:var(--forest);font-weight:800;}

          .precios-grid{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:60px;}
          .precio-card{flex:1;min-width:280px;background:var(--paper);border-radius:22px;border:1px solid var(--line);overflow:hidden;box-shadow:0 10px 22px rgba(9,49,30,.05);}
          .precio-card-titulo{background:var(--forest);color:#fff;padding:18px 22px 6px;font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;}
          .precio-card-sub{background:var(--forest);color:#bcd3c4;padding:0 22px 16px;font-size:.72rem;letter-spacing:.01em;}
          .tabla-precios{width:100%;border-collapse:collapse;font-size:.88rem;}
          .tabla-precios th{text-align:left;padding:11px 22px;font-size:.66rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700;border-bottom:1.5px solid #e2e0d4;}
          .tabla-precios th:not(:first-child),.tabla-precios td:not(:first-child){text-align:right;}
          .tabla-precios td{padding:12px 22px;border-bottom:1px solid #ece9de;font-variant-numeric:tabular-nums;color:var(--ink);}
          .tabla-precios td:first-child{font-weight:600;color:var(--muted);}
          .tabla-precios tr:nth-child(even) td{background:#faf9f3;}
          .tabla-precios tr:last-child td{border-bottom:none;font-weight:800;color:var(--forest);background:#e3efe3!important;}
          .tabla-precios tr:last-child td:first-child{color:var(--forest);}

          .nota{background:#edf2ed;border-radius:20px;padding:26px 30px;color:var(--forest);line-height:1.6;font-size:.92rem;margin-bottom:70px;}

          .faq{margin:20px auto 90px;max-width:860px;}
          .faq-list{display:grid;gap:14px;margin-top:38px;}
          .faq-item{background:var(--paper);border:1px solid var(--line);border-radius:18px;box-shadow:0 8px 18px rgba(9,49,30,.05);overflow:hidden;}
          .faq-item summary{list-style:none;cursor:pointer;padding:21px 58px 21px 24px;font-weight:800;font-size:.96rem;position:relative;color:var(--ink);}
          .faq-item summary::-webkit-details-marker{display:none;}
          .faq-item summary::after{content:'+';position:absolute;right:24px;top:50%;transform:translateY(-50%);width:28px;height:28px;border-radius:50%;background:var(--cream);display:flex;align-items:center;justify-content:center;color:var(--forest);font-size:1.2rem;}
          .faq-item[open] summary::after{content:'−';background:var(--gold);color:var(--ink);}
          .faq-item p{margin:0;padding:0 24px 22px;color:var(--muted);font-size:.9rem;line-height:1.65;max-width:760px;}

          .contacto{text-align:center;padding:20px 0 40px;}
          .cta{display:inline-block;background:var(--forest);color:#fff;text-decoration:none;padding:16px 30px;border-radius:999px;font-weight:700;box-shadow:0 12px 22px rgba(9,67,43,.18);}

          .site-footer{border-top:1px solid var(--line);padding:26px max(24px,calc((100vw - 1120px)/2));display:flex;justify-content:space-between;gap:20px;color:#486454;font-size:.84rem;}
          .site-footer a{color:#345c46;text-decoration:none;margin-left:16px;}

          @media(max-width:760px){
            .site-header{height:64px;}
            .site-nav a:not(.site-order){display:none;}
            .site-order{padding:10px 15px;}
            .hero h1{font-size:2.4rem;}
            .contenido{padding:60px 20px;}
            #como-funciona,#accesos,#precios,.faq{padding:46px 20px;border-radius:24px;margin-bottom:48px;}
            .stats-strip{grid-template-columns:1fr;}
            .stats-strip div{border-right:none;border-bottom:1px solid var(--line);}
            .stats-strip div:last-child{border-bottom:none;}
            .accesos{grid-template-columns:1fr;}
            .flujo{padding:28px 20px;}
            .planes,.precios-grid{flex-direction:column;}
            .site-footer{flex-direction:column;}
            .site-footer span:last-child{display:flex;gap:16px;margin-top:6px;}
          }
        </style>
      </head>
      <body>
        <header class="site-header">
          <a class="site-brand" href="/" aria-label="Tapin inicio">${logoSvg(MARCA.verdeOscuro, 25)}</a>
          <nav class="site-nav" aria-label="Navegación principal">
            <a href="#como-funciona">Cómo funciona</a>
            <a href="#accesos">Accesos</a>
            <a href="#precios">Precios</a>
            <a href="#preguntas">Preguntas</a>
            <a class="site-order" href="/pedido">Pedir tarjeta</a>
          </nav>
        </header>

        <div class="hero">
          <div class="hero-kicker">HECHO EN COLOMBIA · SIN COMPLICACIONES · SIN FRICCIÓN</div>
          <h1>Más reseñas. Mejor reputación.</h1>
          <p>Tapin convierte cada visita a tu negocio en una reseña de Google. El cliente acerca su celular a tu tarjeta y listo.</p>
          <div class="hero-cta-row">
            <a class="hero-cta-main" href="/pedido">Pedir mi tarjeta →</a>
            <a class="hero-cta-alt" href="#como-funciona">Ver cómo funciona</a>
          </div>
          <div class="tarjeta-wrap">
            <div class="tarjeta-nfc">
              <div class="tarjeta-logo">${logoSvg(MARCA.texto, 16)}</div>
              <svg class="tarjeta-nfc-icono" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M6 9C7.5 10.2 8.4 11.9 8.4 13.8C8.4 15.7 7.5 17.4 6 18.6" stroke="${MARCA.textoSuave}" stroke-width="1.6" stroke-linecap="round"/>
                <path d="M9.5 6.5C11.8 8.4 13.2 11 13.2 14C13.2 17 11.8 19.6 9.5 21.5" stroke="${MARCA.textoSuave}" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>
              </svg>
              <div class="tarjeta-google"><span>G</span><span>o</span><span>o</span><span>g</span><span>l</span><span>e</span></div>
              <div class="tarjeta-estrellas">★★★★★</div>
              <div class="tarjeta-texto">Déjanos una reseña<br>en Google</div>
              <svg class="tarjeta-mano" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9 12V6.5C9 5.67 9.67 5 10.5 5C11.33 5 12 5.67 12 6.5V11" stroke="${MARCA.texto}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M12 11V5.5C12 4.67 12.67 4 13.5 4C14.33 4 15 4.67 15 5.5V11" stroke="${MARCA.texto}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M15 11V6.5C15 5.67 15.67 5 16.5 5C17.33 5 18 5.67 18 6.5V13C18 16.87 14.87 20 11 20C9 20 7.5 19 6.3 17.3L4 13.5C3.6 12.8 3.9 11.9 4.7 11.6C5.3 11.4 6 11.6 6.4 12.1L8 14" stroke="${MARCA.texto}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M20 5C21 6 21.5 7.3 21.5 8.5" stroke="${MARCA.oro}" stroke-width="1.4" stroke-linecap="round"/>
                <path d="M22 3C23.5 4.5 24.3 6.4 24.3 8.5" stroke="${MARCA.oro}" stroke-width="1.4" stroke-linecap="round" opacity="0.5"/>
              </svg>
            </div>
          </div>
        </div>

        <div class="contenido">
          <div class="stats-strip">
            <div><strong>Sin complicaciones</strong><span>Funciona desde cualquier celular</span></div>
            <div><strong>1 toque</strong><span>Para abrir tu enlace de reseñas</span></div>
            <div><strong>En segundos</strong><span>Listo para usar al recibirlo</span></div>
          </div>

          <div id="como-funciona">
            <div class="seccion-titulo">Así funciona Tapin</div>
            <div class="seccion-sub">El proceso es fácil. La diferencia está en el filtro de calificaciones, que es exclusivo del Plan Pro.</div>

            <div class="flujo flujo-basico">
              <div class="flujo-cabecera"><span class="flujo-etiqueta">Sin Plan Pro</span><h3>Con tu tarjeta Tapin</h3></div>
              <p class="flujo-descripcion">El cliente va directamente a dejar su reseña. Este recorrido no incluye el filtro de calificaciones.</p>
              <div class="pasos">
                <div class="paso"><div class="paso-num">1</div><h3>Recibe tu código</h3><p>Tu código de activación llega con tu pedido para que puedas comenzar fácilmente.</p></div>
                <div class="paso"><div class="paso-num">2</div><h3>Activa tu tarjeta</h3><p>Ingresas el código y completas los datos de tu negocio en pocos minutos.</p></div>
                <div class="paso"><div class="paso-num">3</div><h3>El cliente toca la tarjeta</h3><p>Solo acerca su celular a la tarjeta Tapin para abrir el enlace.</p></div>
                <div class="paso"><div class="paso-num">4</div><h3>Deja su reseña en Google Reviews</h3><p>El último paso lleva al cliente a publicar su reseña directamente en Google Reviews.</p></div>
              </div>
            </div>

            <div class="flujo flujo-pro">
              <div class="flujo-cabecera"><span class="flujo-etiqueta">Con Plan Pro</span><h3>Con filtro de calificaciones</h3></div>
              <p class="flujo-descripcion"><b>Este filtro solo está incluido en el Plan Pro:</b> separa las experiencias positivas y convierte las negativas en retroalimentación privada para el negocio.</p>
              <div class="pasos">
                <div class="paso paso-pro"><div class="paso-num">1</div><h3>Recibe tu código</h3><p>Tu código de activación llega con tu pedido para que puedas comenzar fácilmente.</p></div>
                <div class="paso paso-pro"><div class="paso-num">2</div><h3>Activa tu tarjeta</h3><p>Ingresas el código, completas los datos y activas el Plan Pro.</p></div>
                <div class="paso paso-pro"><div class="paso-num">3</div><h3>El cliente toca y califica</h3><p>Al acercar el celular, se abre una página sencilla para calificar la experiencia.</p></div>
                <div class="paso paso-pro"><div class="paso-pro-badge">Solo Pro</div><div class="paso-num">4</div><h3>El filtro separa la calificación</h3><p>Las experiencias positivas siguen hacia Google y las negativas se reciben de forma privada.</p></div>
                <div class="paso paso-pro"><div class="paso-pro-badge">Solo Pro</div><div class="paso-num">5</div><h3>Reseña pública o retroalimentación privada</h3><p>Si fue positiva, el cliente deja su reseña en Google Reviews; si fue negativa, el negocio la recibe de forma privada y obtiene una alerta instantánea.</p></div>
                <div class="paso paso-pro"><div class="paso-pro-badge">Solo Pro</div><div class="paso-num">6</div><h3>Recibe el reporte mensual</h3><p>El último paso es un reporte mensual con todas tus estadísticas y análisis: horas pico, subidas, caídas y comparación con otros negocios de tu sector.</p></div>
              </div>
            </div>
          </div>

          <div id="accesos">
            <div class="seccion-titulo">Elige cómo continuar</div>
            <div class="seccion-sub">Encuentra el acceso que necesitas.</div>
            <div class="accesos">
              <a class="acceso acceso-1" href="/pedido"><div class="acceso-badge">RECOMENDADO</div><div class="acceso-icono">✦</div><h3>Pedir tarjeta</h3><p>Solicita tu Tapin y recíbela configurada para tu negocio.</p><span class="acceso-flecha">Quiero mi Tapin →</span></a>
              <a class="acceso acceso-3" href="/mis-negocios"><div class="acceso-icono">▣</div><h3>Tengo un negocio</h3><p>Activa tu tarjeta o entra al panel de tu negocio.</p><span class="acceso-flecha">Entrar a mi negocio →</span></a>
              <a class="acceso acceso-4" href="/descubre"><div class="acceso-icono">⌖</div><h3>Descubrir negocios</h3><p>Explora el mapa de negocios que ya usan Tapin.</p><span class="acceso-flecha">Ver el mapa →</span></a>
            </div>
          </div>

          <div id="precios">
            <div class="seccion-titulo">Lo que cuesta, sin letra pequeña</div>
            <div class="seccion-sub">Pago único para empezar, o Plan Pro si quieres el filtro, retroalimentación privada, reportes y más. Para pagar la mensualidad Pro primero debes tener una tarjeta Tapin.</div>
            <div class="planes">
              <div class="plan">
                <div class="plan-nombre">Pago único</div>
                <div class="plan-precio">$${PRECIO_BASICO_COP.toLocaleString("es-CO")}<span> COP</span></div>
                <ul>
                  <li><span class="check">✓</span> Tarjeta NFC física + envío incluido</li>
                  <li><span class="check">✓</span> Redirección automática a tus reseñas de Google</li>
                  <li><span class="check">✓</span> Panel con historial y estadísticas</li>
                  <li><span class="check">✓</span> Acta de entrega formal</li>
                </ul>
              </div>
              <div class="plan pro">
                <div class="plan-badge">RECOMENDADO</div>
                <div class="plan-nombre">Mensualidad Pro</div>
                <div class="plan-precio">$${PRECIO_PRO_COP.toLocaleString("es-CO")}<span> COP/mes</span></div>
                <div class="plan-anual">
                  <div><div class="plan-anual-etiqueta">Pago anual</div><div class="plan-anual-precio">$${PRECIO_PRO_ANUAL_COP.toLocaleString("es-CO")} COP/año</div></div>
                  <div class="plan-anual-badge">10% más barato</div>
                </div>
                <ul>
                  <li><span class="check">✓</span> Requiere tener una tarjeta Tapin activa</li>
                  <li><span class="check">✓</span> Todo lo del pago único, más:</li>
                  <li><span class="check">✓</span> Filtro de calificaciones y retroalimentación privada</li>
                  <li><span class="check">✓</span> Alerta instantánea ante retroalimentación negativa</li>
                  <li><span class="check">✓</span> Historial detallado de cada toque y estadísticas completas</li>
                  <li><span class="check">✓</span> Reporte PDF mensual con horas pico, subidas y caídas</li>
                  <li><span class="check">✓</span> Comparación y análisis frente a negocios del mismo sector</li>
                  <li><span class="check">✓</span> Exportación de reportes en CSV, PDF y Word</li>
                  <li><span class="check">✓</span> Recomendaciones automáticas para tu negocio</li>
                  <li><span class="check">✓</span> Programa de fidelización de clientes</li>
                </ul>
              </div>
            </div>
            <div class="precios-grid">
              <div class="precio-card">
                <div class="precio-card-titulo">Compra de tarjetas</div>
                <div class="precio-card-sub">Precio por unidad según cuántas pidas de una vez</div>
                <table class="tabla-precios">
                  <tr><th>Cantidad</th><th>Precio c/u</th><th>Ahorro</th></tr>
                  ${ESCALONES_DESCUENTO.slice().reverse().map((e, i, arr) => {
                    const siguiente = arr[i + 1];
                    const rango = siguiente ? `${e.minimo}-${siguiente.minimo - 1}` : `${e.minimo}+`;
                    return `<tr><td>${rango}</td><td>$${e.precio.toLocaleString("es-CO")}</td><td>${e.descuento || "—"}</td></tr>`;
                  }).join("")}
                </table>
              </div>
              <div class="precio-card">
                <div class="precio-card-titulo">Suscripción Plan Pro</div>
                <div class="precio-card-sub">Precio mensual por tarjeta según cuántas tengas activas</div>
                <table class="tabla-precios tabla-pro">
                  <tr><th>Tarjetas activas</th><th>Precio mensual</th></tr>
                  ${filasTablaProHtml()}
                </table>
              </div>
            </div>
          </div>

          <div class="faq" id="preguntas">
            <div class="seccion-titulo">Dudas frecuentes</div>
            <div class="seccion-sub">Lo esencial antes de pedir y activar tu tarjeta Tapin.</div>
            <div class="faq-list">
              <details class="faq-item">
                <summary>¿Necesito instalar una aplicación?</summary>
                <p>No. Tapin funciona desde el navegador del celular, sin instalaciones ni configuraciones complicadas para tus clientes.</p>
              </details>
              <details class="faq-item">
                <summary>¿Cómo usa el cliente la tarjeta?</summary>
                <p>Acerca su celular a la tarjeta mediante NFC. El enlace se abre en segundos para continuar con la reseña.</p>
              </details>
              <details class="faq-item">
                <summary>¿Cómo activo mi Tapin cuando lo recibo?</summary>
                <p>Recibes un código de activación, completas los datos de tu negocio y conectas tu perfil de Google. El proceso está diseñado para hacerse en pocos minutos.</p>
              </details>
              <details class="faq-item">
                <summary>¿Cuál es la diferencia entre la tarjeta y el Plan Pro?</summary>
                <p>La compra básica incluye la tarjeta física, el envío y el acceso esencial. El Plan Pro añade el filtro de calificaciones, retroalimentación privada, alertas, estadísticas detalladas, reportes y otras herramientas avanzadas.</p>
              </details>
              <details class="faq-item">
                <summary>¿Necesito una tarjeta Tapin para contratar el Plan Pro?</summary>
                <p>Sí. La mensualidad Pro funciona sobre una tarjeta Tapin activa. Primero debes tener y activar tu tarjeta para poder utilizar las funciones Pro.</p>
              </details>
              <details class="faq-item">
                <summary>¿Qué hace el filtro exclusivo del Plan Pro?</summary>
                <p>Las experiencias positivas continúan hacia Google Reviews. Las negativas se convierten en retroalimentación privada y generan una alerta para que el negocio pueda atenderlas. Sin Plan Pro, este filtro no está disponible.</p>
              </details>
              <details class="faq-item">
                <summary>¿Qué incluye el reporte mensual Pro?</summary>
                <p>Incluye tus estadísticas completas, actividad, horas pico, subidas y caídas, análisis de resultados y comparación frente a otros negocios de tu sector.</p>
              </details>
              <details class="faq-item">
                <summary>¿Cómo funcionan los pagos del Plan Pro?</summary>
                <p>Puedes elegir mensualidad con renovación automática o pago anual. La suscripción mensual se puede cancelar desde el panel y permanece activa hasta terminar el período ya pagado.</p>
              </details>
            </div>
          </div>

          <div class="nota"><b>Sobre la retroalimentación:</b> cuando un cliente no tiene una buena experiencia, esa información nunca se convierte en una reseña pública negativa. Se queda contigo, en privado, como una oportunidad para mejorar.</div>

          <div class="contacto">
            <div class="seccion-titulo" style="margin-bottom:8px;">¿Tienes alguna pregunta?</div>
            <div class="seccion-sub">Estamos aquí para ayudarte. Escríbenos y te respondemos lo antes posible.</div>
            <div class="hero-cta-row" style="justify-content:center;">
              <a class="hero-cta-main" href="https://wa.me/573003489609" target="_blank">WhatsApp</a>
              <a class="acceso-flecha" style="border:1.5px solid var(--line);color:var(--ink);border-radius:999px;padding:15px 26px;text-decoration:none;font-weight:700;font-size:.92rem;" href="mailto:tapin.notificaciones@gmail.com">tapin.notificaciones@gmail.com</a>
            </div>
          </div>
        </div>

        <footer class="site-footer">
          <span>© ${new Date().getFullYear()} Tapin. Hecho en Colombia.</span>
          <span><a href="/privacidad">Privacidad</a><a href="/terminos">Términos</a><a href="/descubre">Descubrir negocios</a><a href="/admin">Administrador</a></span>
        </footer>
      </body>
    </html>
  `);
});
app.get("/admin", (req, res) => {
  const error = req.query.error;
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Administrador — Tapin</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.verdeOscuro};
               margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
          .box{background:#fff;border-radius:16px;padding:30px 28px;max-width:340px;width:100%;text-align:center;}
          .logo{margin-bottom:18px;display:flex;justify-content:center;}
          h1{font-size:1rem;color:${MARCA.texto};margin:0 0 18px;}
          input{width:100%;padding:13px;border:1px solid ${MARCA.borde};border-radius:10px;font-size:0.92rem;
                margin-bottom:12px;font-family:inherit;}
          .campo-clave{position:relative;}
          .campo-clave input{padding-right:44px;}
          .ver-clave{position:absolute;right:4px;top:4px;bottom:4px;width:36px;background:none;border:none;
                     cursor:pointer;color:${MARCA.textoSuave};padding:0;display:flex;align-items:center;justify-content:center;}
          .ver-clave:hover{color:${MARCA.texto};}
          button{width:100%;background:${MARCA.verdeOscuro};color:#fff;border:none;padding:13px;border-radius:10px;
                 font-weight:700;font-size:0.92rem;cursor:pointer;}
          .error{background:#FBEFE9;color:${MARCA.rojo};padding:10px 14px;border-radius:8px;font-size:0.8rem;margin-bottom:14px;}
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 34)}</div>
          <h1>Acceso de administrador</h1>
          ${error ? `<div class="error">Clave incorrecta.</div>` : ""}
          <form method="GET" action="/admin/entrar">
            <div class="campo-clave">
              <input type="password" id="clave-admin" name="key" required placeholder="Clave de administrador">
              <button type="button" class="ver-clave" id="boton-clave-admin" onclick="alternarClave('clave-admin')">${ICONO_OJO_ABIERTO}</button>
            </div>
            <button type="submit">Entrar</button>
          </form>
        </div>
        <script>
          function alternarClave(id) {
            const campo = document.getElementById(id);
            const boton = document.getElementById('boton-clave-' + id.replace('clave-', ''));
            const oculto = campo.type === 'password';
            campo.type = oculto ? 'text' : 'password';
            boton.innerHTML = oculto ? ${JSON.stringify(ICONO_OJO_CERRADO)} : ${JSON.stringify(ICONO_OJO_ABIERTO)};
          }
        </script>
      </body>
    </html>
  `);
});

app.get("/admin/entrar", limitarIntentos(6, 15), (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.redirect("/admin?error=1");
  }
  res.redirect(`/stats?key=${encodeURIComponent(req.query.key)}`);
});

// ---------- Flujo de compra: pedido → pago con Wompi → confirmación ----------
// Esto es para el Plan Básico ($119.900 COP, pago único, incluye la tarjeta física y el envío
// y el envío). El Plan Pro (mensual) necesita una integración distinta — ver nota
// al final del archivo README sobre pagos recurrentes.
const PRECIO_BASICO_COP = 119900;
const PRECIO_PRO_COP = 59900;
const PRECIO_PRO_ANUAL_COP = 649900; // pago único, cubre 12 meses (~10% más barato que mes a mes)
// Mientras más locales activos en Plan Pro tenga el mismo negocio, más paga
// por cada uno — al contrario que las tarjetas: un negocio grande saca más
// valor de comparar entre sus propias sedes, así que tiene sentido que pague
// más por local, no menos. Ya anunciado en /conoce.
const ESCALONES_PRO = [
  { minimo: 50, precio: 199900 },
  { minimo: 25, precio: 159900 },
  { minimo: 10, precio: 119900 },
  { minimo: 4, precio: 89900 },
  { minimo: 1, precio: PRECIO_PRO_COP },
];

// Filas comerciales de la tabla pública. A partir de 100 tarjetas se prepara
// una cotización empresarial en lugar de publicar una tarifa automática.
const FILAS_TABLA_PRO = [
  { rango: "1–3", precio: 59900 },
  { rango: "4–9", precio: 89900 },
  { rango: "10–24", precio: 119900 },
  { rango: "25–49", precio: 159900 },
  { rango: "50–99", precio: 199900 },
  { rango: "100+", cotizacion: true },
];

function filasTablaProHtml() {
  return FILAS_TABLA_PRO.map((fila) => `
    <tr class="${fila.cotizacion ? "fila-empresa" : ""}">
      <td>${fila.rango}</td>
      <td>${fila.cotizacion ? "Cotización empresarial" : `$${fila.precio.toLocaleString("es-CO")}`}</td>
    </tr>`).join("");
}

// Descuento por volumen — Plan D (Redondos: 10/20/30/35/40%). El precio por
// tarjeta baja según cuántas se pidan de una vez, pero nunca por debajo de
// un margen saludable.
const ESCALONES_DESCUENTO = [
  { minimo: 100, precio: 71900, descuento: "40%" },
  { minimo: 50, precio: 77900, descuento: "35%" },
  { minimo: 25, precio: 83900, descuento: "30%" },
  { minimo: 10, precio: 95900, descuento: "20%" },
  { minimo: 4, precio: 107900, descuento: "10%" },
  { minimo: 1, precio: PRECIO_BASICO_COP, descuento: null },
];
function precioTarjetaPorCantidad(cantidad) {
  const escalon = ESCALONES_DESCUENTO.find((e) => cantidad >= e.minimo);
  return escalon || ESCALONES_DESCUENTO[ESCALONES_DESCUENTO.length - 1];
}

// Departamentos y municipios de Colombia, para el selector de ciudad en /pedido.
const COLOMBIA_CIUDADES = {"Amazonas":["Leticia","Puerto Nariño"],"Antioquia":["Abejorral","Abriaquí","Alejandría","Amagá","Amalfi","Andes","Angelópolis","Angostura","Anorí","Anzá","Apartadó","Arboletes","Argelia","Armenia","Barbosa","Bello","Belmira","Betania","Betulia","Briceño","Buriticá","Cáceres","Caicedo","Caldas","Campamento","Cañasgordas","Caracolí","Caramanta","Carepa","Carolina del Príncipe","Caucasia","Chigorodó","Cisneros","Ciudad Bolívar","Cocorná","Concepción","Concordia","Copacabana","Dabeiba","Donmatías","Ebéjico","El Bagre","El Carmen de Viboral","El Peñol","El Retiro","El Santuario","Entrerríos","Envigado","Fredonia","Frontino","Giraldo","Girardota","Gómez Plata","Granada","Guadalupe","Guarne","Guatapé","Heliconia","Hispania","Itagüí","Ituango","Jardín","Jericó","La Ceja","La Estrella","La Pintada","La Unión","Liborina","Maceo","Marinilla","Medellín","Montebello","Murindó","Mutatá","Nariño","Nechí","Necoclí","Olaya","Peque","Pueblorrico","Puerto Berrío","Puerto Nare","Puerto Triunfo","Remedios","Rionegro","Sabanalarga","Sabaneta","Salgar","San Andrés de Cuerquia","San Carlos","San Francisco","San Jerónimo","San José de la Montaña","San Juan de Urabá","San Luis","San Pedro de los Milagros","San Pedro de Urabá","San Rafael","San Roque","San Vicente","Santa Bárbara","Santa Fe de Antioquia","Santa Rosa de Osos","Santo Domingo","Segovia","Sonsón","Sopetrán","Támesis","Tarazá","Tarso","Titiribí","Toledo","Turbo","Uramita","Urrao","Valdivia","Valparaíso","Vegachí","Venecia","Vigía del Fuerte","Yalí","Yarumal","Yolombó","Yondó","Zaragoza"],"Arauca":["Arauca","Arauquita","Cravo Norte","Fortul","Puerto Rondón","Saravena","Tame"],"Atlántico":["Baranoa","Barranquilla","Campo de la Cruz","Candelaria","Galapa","Juan de Acosta","Luruaco","Malambo","Manatí","Palmar de Varela","Piojó","Polonuevo","Ponedera","Puerto Colombia","Repelón","Sabanagrande","Sabanalarga","Santa Lucía","Santo Tomás","Soledad","Suán","Tubará","Usiacurí"],"Bolívar":["Achí","Altos del Rosario","Arenal","Arjona","Arroyohondo","Barranco de Loba","Brazuelo de Papayal","Calamar","Cantagallo","Cartagena de Indias","Cicuco","Clemencia","Córdoba","El Carmen de Bolívar","El Guamo","El Peñón","Hatillo de Loba","Magangué","Mahates","Margarita","María la Baja","Mompós","Montecristo","Morales","Norosí","Pinillos","Regidor","Río Viejo","San Cristóbal","San Estanislao","San Fernando","San Jacinto","San Jacinto del Cauca","San Juan Nepomuceno","San Martín de Loba","San Pablo","Santa Catalina","Santa Rosa","Santa Rosa del Sur","Simití","Soplaviento","Talaigua Nuevo","Tiquisio","Turbaco","Turbaná","Villanueva","Zambrano"],"Boyacá":["Almeida","Aquitania","Arcabuco","Belén","Berbeo","Betéitiva","Boavita","Boyacá","Briceño","Buenavista","Busbanzá","Caldas","Campohermoso","Cerinza","Chinavita","Chiquinquirá","Chíquiza","Chiscas","Chita","Chitaraque","Chivatá","Chivor","Ciénega","Cómbita","Coper","Corrales","Covarachía","Cubará","Cucaita","Cuítiva","Duitama","El Cocuy","El Espino","Firavitoba","Floresta","Gachantivá","Gámeza","Garagoa","Guacamayas","Guateque","Guayatá","Güicán","Iza","Jenesano","Jericó","La Capilla","La Uvita","La Victoria","Labranzagrande","Macanal","Maripí","Miraflores","Mongua","Monguí","Moniquirá","Motavita","Muzo","Nobsa","Nuevo Colón","Oicatá","Otanche","Pachavita","Páez","Paipa","Pajarito","Panqueba","Pauna","Paya","Paz del Río","Pesca","Pisba","Puerto Boyacá","Quípama","Ramiriquí","Ráquira","Rondón","Saboyá","Sáchica","Samacá","San Eduardo","San José de Pare","San Luis de Gaceno","San Mateo","San Miguel de Sema","San Pablo de Borbur","Santa María","Santa Rosa de Viterbo","Santa Sofía","Santana","Sativanorte","Sativasur","Siachoque","Soatá","Socha","Socotá","Sogamoso","Somondoco","Sora","Soracá","Sotaquirá","Susacón","Sutamarchán","Sutatenza","Tasco","Tenza","Tibaná","Tibasosa","Tinjacá","Tipacoque","Toca","Togüí","Tópaga","Tota","Tunja","Tununguá","Turmequé","Tuta","Tutazá","Úmbita","Ventaquemada","Villa de Leyva","Viracachá","Zetaquira"],"Caldas":["Aguadas","Anserma","Aranzazu","Belalcázar","Chinchiná","Filadelfia","La Dorada","La Merced","Manizales","Manzanares","Marmato","Marquetalia","Marulanda","Neira","Norcasia","Pácora","Palestina","Pensilvania","Riosucio","Risaralda","Salamina","Samaná","San José","Supía","Victoria","Villamaría","Viterbo"],"Caquetá":["Albania","Belén de los Andaquíes","Cartagena del Chairá","Curillo","El Doncello","El Paujil","Florencia","La Montañita","Milán","Morelia","Puerto Rico","San José del Fragua","San Vicente del Caguán","Solano","Solita","Valparaíso"],"Casanare":["Aguazul","Chámeza","Hato Corozal","La Salina","Maní","Monterrey","Nunchía","Orocué","Paz de Ariporo","Pore","Recetor","Sabanalarga","Sácama","San Luis de Palenque","Támara","Tauramena","Trinidad","Villanueva","Yopal"],"Cauca":["Almaguer","Argelia","Balboa","Bolívar","Buenos Aires","Cajibío","Caldono","Caloto","Corinto","El Tambo","Florencia","Guachené","Guapí","Inzá","Jambaló","La Sierra","La Vega","López de Micay","Mercaderes","Miranda","Morales","Padilla","Páez","Patía","Piamonte","Piendamó","Popayán","Puerto Tejada","Puracé","Rosas","San Sebastián","Santa Rosa","Santander de Quilichao","Silvia","Sotará","Suárez","Sucre","Timbío","Timbiquí","Toribío","Totoró","Villa Rica"],"Cesar":["Aguachica","Agustín Codazzi","Astrea","Becerril","Bosconia","Chimichagua","Chiriguaná","Curumaní","El Copey","El Paso","Gamarra","González","La Gloria (Cesar)","La Jagua de Ibirico","La Paz","Manaure Balcón del Cesar","Pailitas","Pelaya","Pueblo Bello","Río de Oro","San Alberto","San Diego","San Martín","Tamalameque","Valledupar"],"Chocó":["Acandí","Alto Baudó","Bagadó","Bahía Solano","Bajo Baudó","Bojayá","Cantón de San Pablo","Cértegui","Condoto","El Atrato","El Carmen de Atrato","El Carmen del Darién","Istmina","Juradó","Litoral de San Juan","Lloró","Medio Atrato","Medio Baudó","Medio San Juan","Nóvita","Nuquí","Quibdó","Río Iró","Río Quito","Riosucio","San José del Palmar","Sipí","Tadó","Unguía","Unión Panamericana"],"Córdoba":["Ayapel","Buenavista","Canalete","Cereté","Chimá","Chinú","Ciénaga de Oro","Cotorra","La Apartada","Lorica","Los Córdobas","Momil","Montelíbano","Montería","Moñitos","Planeta Rica","Pueblo Nuevo","Puerto Escondido","Puerto Libertador","Purísima","Sahagún","San Andrés de Sotavento","San Antero","San Bernardo del Viento","San Carlos","San José de Uré","San Pelayo","Tierralta","Tuchín","Valencia"],"Cundinamarca":["Agua de Dios","Albán","Anapoima","Anolaima","Apulo","Arbeláez","Beltrán","Bituima","Bogotá","Bojacá","Cabrera","Cachipay","Cajicá","Caparrapí","Cáqueza","Carmen de Carupa","Chaguaní","Chía","Chipaque","Choachí","Chocontá","Cogua","Cota","Cucunubá","El Colegio","El Peñón","El Rosal","Facatativá","Fómeque","Fosca","Funza","Fúquene","Fusagasugá","Gachalá","Gachancipá","Gachetá","Gama","Girardot","Granada","Guachetá","Guaduas","Guasca","Guataquí","Guatavita","Guayabal de Síquima","Guayabetal","Gutiérrez","Jerusalén","Junín","La Calera","La Mesa","La Palma","La Peña","La Vega","Lenguazaque","Machetá","Madrid","Manta","Medina","Mosquera","Nariño","Nemocón","Nilo","Nimaima","Nocaima","Pacho","Paime","Pandi","Paratebueno","Pasca","Puerto Salgar","Pulí","Quebradanegra","Quetame","Quipile","Ricaurte","San Antonio del Tequendama","San Bernardo","San Cayetano","San Francisco","San Juan de Rioseco","Sasaima","Sesquilé","Sibaté","Silvania","Simijaca","Soacha","Sopó","Subachoque","Suesca","Supatá","Susa","Sutatausa","Tabio","Tausa","Tena","Tenjo","Tibacuy","Tibirita","Tocaima","Tocancipá","Topaipí","Ubalá","Ubaque","Ubaté","Une","Útica","Venecia","Vergara","Vianí","Villagómez","Villapinzón","Villeta","Viotá","Yacopí","Zipacón","Zipaquirá"],"Guainía":["Inírida"],"Guaviare":["Calamar","El Retorno","Miraflores","San José del Guaviare"],"Huila":["Acevedo","Agrado","Aipe","Algeciras","Altamira","Baraya","Campoalegre","Colombia","El Pital","Elías","Garzón","Gigante","Guadalupe","Hobo","Íquira","Isnos","La Argentina","La Plata","Nátaga","Neiva","Oporapa","Paicol","Palermo","Palestina","Pitalito","Rivera","Saladoblanco","San Agustín","Santa María","Suaza","Tarqui","Tello","Teruel","Tesalia","Timaná","Villavieja","Yaguará"],"La Guajira":["Albania","Barrancas","Dibulla","Distracción","El Molino","Fonseca","Hatonuevo","La Jagua del Pilar","Maicao","Manaure","Riohacha","San Juan del Cesar","Uribia","Urumita","Villanueva"],"Magdalena":["Algarrobo","Aracataca","Ariguaní","Cerro de San Antonio","Chibolo","Chibolo","Ciénaga","Concordia","El Banco","El Piñón","El Retén","Fundación","Guamal","Nueva Granada","Pedraza","Pijiño del Carmen","Pivijay","Plato","Pueblo Viejo","Remolino","Sabanas de San Ángel","Salamina","San Sebastián de Buenavista","San Zenón","Santa Ana","Santa Bárbara de Pinto","Santa Marta","Sitionuevo","Tenerife","Zapayán","Zona Bananera"],"Meta":["Acacías","Barranca de Upía","Cabuyaro","Castilla la Nueva","Cubarral","Cumaral","El Calvario","El Castillo","El Dorado","Fuente de Oro","Granada","Guamal","La Macarena","La Uribe","Lejanías","Mapiripán","Mesetas","Puerto Concordia","Puerto Gaitán","Puerto Lleras","Puerto López","Puerto Rico","Restrepo","San Carlos de Guaroa","San Juan de Arama","San Juanito","San Martín","Villavicencio","Vista Hermosa"],"Nariño":["Aldana","Ancuyá","Arboleda","Barbacoas","Belén","Buesaco","Chachagüí","Colón","Consacá","Contadero","Córdoba","Cuaspud","Cumbal","Cumbitara","El Charco","El Peñol","El Rosario","El Tablón","El Tambo","Francisco Pizarro","Funes","Guachucal","Guaitarilla","Gualmatán","Iles","Imués","Ipiales","La Cruz","La Florida","La Llanada","La Tola","La Unión","Leiva","Linares","Los Andes","Magüí Payán","Mallama","Mosquera","Nariño","Olaya Herrera","Ospina","Pasto","Policarpa","Potosí","Providencia","Puerres","Pupiales","Ricaurte","Roberto Payán","Samaniego","San Bernardo","San José de Albán","San Lorenzo","San Pablo","San Pedro de Cartago","Sandoná","Santa Bárbara","Santacruz","Sapuyes","Taminango","Tangua","Tumaco","Túquerres","Yacuanquer"],"Norte de Santander":["Ábrego","Arboledas","Bochalema","Bucarasica","Cáchira","Cácota","Chinácota","Chitagá","Convención","Cúcuta","Cucutilla","Duranía","El Carmen","El Tarra","El Zulia","Gramalote","Hacarí","Herrán","La Esperanza","La Playa de Belén","Labateca","Los Patios","Lourdes","Mutiscua","Ocaña","Pamplona","Pamplonita","Puerto Santander","Ragonvalia","Salazar de Las Palmas","San Calixto","San Cayetano","Santiago","Santo Domingo de Silos","Sardinata","Teorama","Tibú","Toledo","Villa Caro","Villa del Rosario"],"Putumayo":["Colón","Mocoa","Orito","Puerto Asís","Puerto Caicedo","Puerto Guzmán","Puerto Leguízamo","San Francisco","San Miguel","Santiago","Sibundoy","Valle del Guamuez","Villagarzón"],"Quindío":["Armenia","Buenavista","Calarcá","Circasia","Córdoba","Filandia","Génova","La Tebaida","Montenegro","Pijao","Quimbaya","Salento"],"Risaralda":["Apía","Balboa","Belén de Umbría","Dosquebradas","Guática","La Celia","La Virginia","Marsella","Mistrató","Pereira","Pueblo Rico","Quinchía","Santa Rosa de Cabal","Santuario"],"San Andrés y Providencia":["Providencia y Santa Catalina Islas","San Andrés"],"Santander":["Aguada","Albania","Aratoca","Barbosa","Barichara","Barrancabermeja","Betulia","Bolívar","Bucaramanga","Cabrera","California","Capitanejo","Carcasí","Cepitá","Cerrito","Charalá","Charta","Chima","Chipatá","Cimitarra","Concepción","Confines","Contratación","Coromoro","Curití","El Carmen de Chucurí","El Guacamayo","El Peñón","El Playón","El Socorro","Encino","Enciso","Florián","Floridablanca","Galán","Gámbita","Girón","Guaca","Guadalupe","Guapotá","Guavatá","Güepsa","Hato","Jesús María","Jordán","La Belleza","La Paz","Landázuri","Lebrija","Los Santos","Macaravita","Málaga","Matanza","Mogotes","Molagavita","Ocamonte","Oiba","Onzaga","Palmar","Palmas del Socorro","Páramo","Piedecuesta","Pinchote","Puente Nacional","Puerto Parra","Puerto Wilches","Rionegro","Sabana de Torres","San Andrés","San Benito","San Gil","San Joaquín","San José de Miranda","San Miguel","San Vicente de Chucurí","Santa Bárbara","Santa Helena del Opón","Simacota","Suaita","Sucre","Suratá","Tona","Valle de San José","Vélez","Vetas","Villanueva","Zapatoca"],"Sucre":["Buenavista","Caimito","Chalán","Colosó","Corozal","Coveñas","El Roble","Galeras","Guaranda","La Unión","Los Palmitos","Majagual","Morroa","Ovejas","Sampués","San Antonio de Palmito","San Benito Abad","San Juan de Betulia","San Marcos","San Onofre","San Pedro","Sincé","Sincelejo","Sucre","Tolú","Tolú Viejo"],"Tolima":["Alpujarra","Alvarado","Ambalema","Anzoátegui","Armero","Ataco","Cajamarca","Carmen de Apicalá","Casabianca","Chaparral","Coello","Coyaima","Cunday","Dolores","El Espinal","Falán","Flandes","Fresno","Guamo","Herveo","Honda","Ibagué","Icononzo","Lérida","Líbano","Mariquita","Melgar","Murillo","Natagaima","Ortega","Palocabildo","Piedras","Planadas","Prado","Purificación","Rioblanco","Roncesvalles","Rovira","Saldaña","San Antonio","San Luis","Santa Isabel","Suárez","Valle de San Juan","Venadillo","Villahermosa","Villarrica"],"Valle del Cauca":["Alcalá","Andalucía","Ansermanuevo","Argelia","Bolívar","Buenaventura","Buga","Bugalagrande","Caicedonia","Cali","Calima","Candelaria","Cartago","Dagua","El Águila","El Cairo","El Cerrito","El Dovio","Florida","Ginebra","Guacarí","Jamundí","La Cumbre","La Unión","La Victoria","Obando","Palmira","Pradera","Restrepo","Riofrío","Roldanillo","San Pedro","Sevilla","Toro","Trujillo","Tuluá","Ulloa","Versalles","Vijes","Yotoco","Yumbo","Zarzal"],"Vaupés":["Carurú","Mitú","Taraira"],"Vichada":["Cumaribo","La Primavera","Puerto Carreño","Santa Rosalía"]};

// Formulario público donde alguien pide su tarjeta Tapin.
app.get("/pedido", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Pedir mi tarjeta Tapin</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.crema};
               margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:14px;}
          .box{background:#fff;border-radius:16px;padding:24px 26px;max-width:min(820px,100%);width:100%;
               box-shadow:0 10px 40px rgba(0,0,0,0.08);}
          form{max-width:720px;margin:0 auto;}
          form > label,form > input,form > select{display:block;width:100%;}
          form > label{margin-top:0;font-size:0.72rem;}
          form > input,form > select{margin-bottom:9px;padding:10px;font-size:0.84rem;}
          h1{font-size:1.08rem;margin:9px 0 3px;}
          p{font-size:0.78rem;margin-bottom:14px;}
          .precio{padding:10px 12px;margin-bottom:13px;font-size:0.84rem;}
          .descuento-info{padding:9px 11px;margin:-3px 0 12px;font-size:0.74rem;}
          .pro-opcion{padding:9px 11px;margin-bottom:12px;font-size:0.76rem;}
          .pro-opcion .txt{font-size:0.74rem;}
          button{padding:11px;font-size:0.88rem;}
          .pro-opcion{max-width:100%;}
          @media (max-width:640px){body{padding:8px;align-items:flex-start;}.box{padding:18px 16px;}.logo svg{max-width:74px;height:auto;}}
          .logo{margin-bottom:6px;}
          h1{font-size:1.2rem;color:${MARCA.texto};margin:14px 0 4px;}
          p{color:${MARCA.textoSuave};font-size:0.85rem;margin:0 0 22px;}
          label{display:block;font-size:0.78rem;font-weight:700;color:${MARCA.texto};margin:0 0 5px;}
          input,select{width:100%;padding:12px;border:1px solid ${MARCA.borde};border-radius:10px;font-size:0.9rem;
                margin-bottom:14px;font-family:inherit;}
          .precio{background:${MARCA.verdeClaro};color:${MARCA.verdeOscuro};padding:14px 16px;border-radius:10px;
                   font-weight:700;text-align:center;margin-bottom:18px;}
          .descuento-info{background:#FBF6E9;border:1px solid #F0E2B8;border-radius:10px;padding:12px 14px;
                           margin:-6px 0 18px;font-size:0.82rem;color:#7A5A00;display:none;}
          .descuento-info.activo{display:block;}
          .descuento-info b{display:block;font-size:0.95rem;margin-bottom:2px;}
          .pro-opcion{display:flex;align-items:flex-start;gap:10px;background:${MARCA.crema};border:1px solid ${MARCA.borde};
                   border-radius:10px;padding:12px 14px;margin-bottom:18px;}
          .pro-opcion input{width:auto;margin:3px 0 0;}
          .pro-opcion .txt{font-size:0.82rem;color:${MARCA.texto};}
          .pro-opcion .txt b{display:block;font-size:0.85rem;margin-bottom:2px;}
          button{width:100%;background:${MARCA.verde};color:#fff;border:none;padding:14px;border-radius:10px;
                 font-weight:700;font-size:0.95rem;cursor:pointer;}
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 26)}</div>
          <h1>Pide tu tarjeta Tapin</h1>
          <p>Llena tus datos, paga en línea con Wompi, y te enviamos la tarjeta a tu negocio.</p>
          <div class="precio">Plan Básico — $${PRECIO_BASICO_COP.toLocaleString("es-CO")} COP c/u (incluye envío)</div>
          <form method="POST" action="/pedido">
            <label>¿Cuántas tarjetas necesitas?</label>
            <input type="number" name="cantidad" id="input-cantidad" min="1" max="500" value="1" required>
            <div class="descuento-info" id="descuento-info"></div>

            <label>Nombre del negocio</label>
            <input type="text" name="nombreNegocio" required>

            <label>Tu correo</label>
            <input type="email" name="email" required>

            <label>Teléfono</label>
            <input type="tel" name="telefono" required placeholder="300 000 0000">

            <label>Dirección de envío</label>
            <input type="text" name="direccion" required placeholder="Calle/Carrera, número, barrio">

            <label>Departamento</label>
            <select name="departamento" id="sel-departamento" required>
              <option value="">Selecciona un departamento...</option>
            </select>

            <label>Ciudad</label>
            <input type="text" name="ciudad" id="input-ciudad" list="lista-ciudades" required
                   placeholder="Primero elige el departamento" autocomplete="off" disabled>
            <datalist id="lista-ciudades"></datalist>

            <label class="pro-opcion" style="cursor:pointer;">
              <input type="checkbox" name="incluirPro" id="check-incluir-pro" value="si" onchange="document.getElementById('opciones-plan-pro').style.display=this.checked?'block':'none';">
              <span class="txt">
                <b>Incluir Plan Pro</b>
                Rescate de reseñas negativas en tiempo real, reportes mensuales y más. Se cobra junto con tu tarjeta en este mismo pago.
              </span>
            </label>

            <div id="opciones-plan-pro" style="display:none;margin:-6px 0 16px;padding-left:4px;">
              <label style="display:flex;align-items:center;gap:8px;font-weight:400;font-size:0.86rem;margin-bottom:8px;cursor:pointer;">
                <input type="radio" name="planProTipo" value="mensual" checked style="width:auto;margin:0;">
                Mensual — $${PRECIO_PRO_COP.toLocaleString("es-CO")} COP (primer mes; luego se cobra cada mes aparte)
              </label>
              <label style="display:flex;align-items:center;gap:8px;font-weight:400;font-size:0.86rem;cursor:pointer;">
                <input type="radio" name="planProTipo" value="anual" style="width:auto;margin:0;">
                Anual — $${PRECIO_PRO_ANUAL_COP.toLocaleString("es-CO")} COP (año completo, un solo pago, sin cobros después)
              </label>
            </div>

            <label style="margin-top:2px;">¿Necesitas factura a nombre de una empresa? (opcional)</label>
            <input type="text" name="razonSocial" placeholder="Razón social (déjalo vacío si no aplica)">
            <input type="text" name="nit" placeholder="NIT o cédula (opcional)">

            <button type="submit">Continuar al pago</button>
          </form>
        </div>

        <script>
          // Precio escalonado por volumen (Plan B) — mismos tramos que en el servidor.
          const ESCALONES = ${JSON.stringify(ESCALONES_DESCUENTO)};
          const PRECIO_BASE = ${PRECIO_BASICO_COP};
          const inputCantidad = document.getElementById("input-cantidad");
          const descuentoInfo = document.getElementById("descuento-info");

          function actualizarDescuento() {
            const cantidad = Math.max(1, parseInt(inputCantidad.value, 10) || 1);
            const escalon = ESCALONES.find((e) => cantidad >= e.minimo);
            const total = escalon.precio * cantidad;
            if (escalon.descuento) {
              descuentoInfo.innerHTML =
                "<b>¡Descuento por volumen aplicado! " + escalon.descuento + " off</b>" +
                "$" + escalon.precio.toLocaleString("es-CO") + " COP por tarjeta × " + cantidad +
                " = $" + total.toLocaleString("es-CO") + " COP total (antes $" +
                (PRECIO_BASE * cantidad).toLocaleString("es-CO") + ")";
              descuentoInfo.classList.add("activo");
            } else {
              descuentoInfo.classList.remove("activo");
            }
          }
          inputCantidad.addEventListener("input", actualizarDescuento);
          actualizarDescuento();

          // Departamentos y ciudades de Colombia — el usuario elige primero el
          // departamento, y la ciudad se autocompleta filtrando solo las de ese
          // departamento (igual que en cualquier formulario de dirección).
          const COLOMBIA_CIUDADES = ${JSON.stringify(COLOMBIA_CIUDADES)};

          const selDepto = document.getElementById("sel-departamento");
          const inputCiudad = document.getElementById("input-ciudad");
          const listaCiudades = document.getElementById("lista-ciudades");

          Object.keys(COLOMBIA_CIUDADES).forEach((depto) => {
            const opt = document.createElement("option");
            opt.value = depto;
            opt.textContent = depto;
            selDepto.appendChild(opt);
          });

          selDepto.addEventListener("change", () => {
            listaCiudades.innerHTML = "";
            inputCiudad.value = "";
            const ciudades = COLOMBIA_CIUDADES[selDepto.value] || [];
            if (ciudades.length) {
              inputCiudad.disabled = false;
              inputCiudad.placeholder = "Escribe para buscar tu ciudad...";
              ciudades.forEach((c) => {
                const opt = document.createElement("option");
                opt.value = c;
                listaCiudades.appendChild(opt);
              });
            } else {
              inputCiudad.disabled = true;
              inputCiudad.placeholder = "Primero elige el departamento";
            }
          });
        </script>
      </body>
    </html>
  `);
});

app.post("/pedido", (req, res) => {
  const { nombreNegocio, email, telefono, direccion, ciudad, departamento, incluirPro, planProTipo, cantidad, nit, razonSocial } = req.body;
  if (!nombreNegocio || !email || !telefono || !direccion || !ciudad || !departamento) {
    return res.status(400).send("Faltan datos del pedido.");
  }

  const cantidadLimpia = Math.min(500, Math.max(1, parseInt(cantidad, 10) || 1));
  const escalon = precioTarjetaPorCantidad(cantidadLimpia);
  const proIncluido = incluirPro === "si";
  const tipoProElegido = planProTipo === "anual" ? "anual" : "mensual";
  const precioProElegido = tipoProElegido === "anual" ? PRECIO_PRO_ANUAL_COP : PRECIO_PRO_COP;
  const monto = escalon.precio * cantidadLimpia + (proIncluido ? precioProElegido : 0);

  const pedidos = leerPedidos();
  const id = generarToken();
  pedidos[id] = {
    nombreNegocio, email, telefono, direccion, ciudad, departamento,
    // Opcional — solo si el comprador necesita factura a nombre de una
    // empresa. Queda guardado en el pedido y en cada tarjeta generada, listo
    // para cuando se conecte un proveedor de facturación electrónica.
    nit: (nit || "").trim(),
    razonSocial: (razonSocial || "").trim(),
    cantidad: cantidadLimpia,
    precioUnidad: escalon.precio,
    descuentoAplicado: escalon.descuento,
    proIncluido,
    planProTipo: proIncluido ? tipoProElegido : null,
    // Solo aplica al Plan Pro MENSUAL (el anual es pago único, no necesita
    // tarjeta guardada). Marcado por defecto — el cliente lo puede
    // destildar en la pantalla de pago si no quiere que se renueve solo.
    renovarAutomatico: proIncluido && tipoProElegido === "mensual",
    monto,
    estado: "pendiente", // pendiente | aprobado | rechazado
    creado: new Date().toISOString(),
  };
  guardarPedidos(pedidos);

  res.redirect(`/pagar/${id}`);
});

// Página de pago — embebe el Web Checkout de Wompi con la firma de
// integridad calculada en el servidor (nunca se expone el secreto al
// navegador). Actualiza en caliente si el cliente quiere que su Plan Pro
// mensual se renueve solo — se llama desde la casilla en /pagar/:id, ANTES
// de que le dé clic al botón de Wompi (que lo saca de nuestro sitio).
app.post("/pedido/:id/renovar-automatico", (req, res) => {
  const pedidos = leerPedidos();
  const pedido = pedidos[req.params.id];
  if (!pedido) return res.status(404).json({ ok: false });
  if (!pedido.proIncluido || pedido.planProTipo !== "mensual") return res.status(400).json({ ok: false });
  pedido.renovarAutomatico = !!(req.body && req.body.renovar);
  pedidos[req.params.id] = pedido;
  guardarPedidos(pedidos);
  res.json({ ok: true });
});

app.get("/pagar/:id", (req, res) => {
  const pedidos = leerPedidos();
  const pedido = pedidos[req.params.id];
  if (!pedido) return res.status(404).send("Pedido no encontrado.");

  if (!process.env.WOMPI_PUBLIC_KEY || !process.env.WOMPI_INTEGRITY_SECRET) {
    return res.status(500).send(
      "Los pagos todavía no están configurados. Faltan WOMPI_PUBLIC_KEY y/o " +
      "WOMPI_INTEGRITY_SECRET como variables de entorno en Render."
    );
  }

  const referencia = `tapin-${req.params.id}`;
  const montoCentavos = pedido.monto * 100;
  const moneda = "COP";
  const firma = firmaIntegridadWompi(referencia, montoCentavos, moneda);
  const redirectUrl = `${req.protocol}://${req.get("host")}/pago-confirmado?pedido=${req.params.id}`;

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Pagar — Tapin</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.crema};
               margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
          .box{background:#fff;border-radius:18px;padding:34px 30px;max-width:420px;width:100%;text-align:center;
               box-shadow:0 10px 40px rgba(0,0,0,0.08);}
          h1{font-size:1.1rem;color:${MARCA.texto};margin:14px 0 6px;}
          .resumen{background:${MARCA.crema};border-radius:10px;padding:16px;margin:18px 0;text-align:left;font-size:0.85rem;color:${MARCA.textoSuave};}
          .resumen b{color:${MARCA.texto};}
          .monto{font-size:1.6rem;font-weight:800;color:${MARCA.verde};margin:12px 0;}
          button{width:100%;background:${MARCA.verde};color:#fff;border:none;padding:14px;border-radius:10px;
                 font-weight:700;font-size:0.95rem;cursor:pointer;margin-top:6px;}
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 26)}</div>
          <h1>Confirma tu pago</h1>
          <div class="resumen">
            <div><b>Negocio:</b> ${pedido.nombreNegocio}</div>
            <div><b>Envío a:</b> ${pedido.direccion}, ${pedido.ciudad}, ${pedido.departamento}</div>
            <div style="margin-top:8px;">
              <b>Plan Básico:</b> ${pedido.cantidad || 1} tarjeta${(pedido.cantidad || 1) > 1 ? "s" : ""}
              × $${(pedido.precioUnidad || PRECIO_BASICO_COP).toLocaleString("es-CO")} COP c/u
            </div>
            ${pedido.descuentoAplicado ? `<div style="color:#7A5A00;">✓ Descuento por volumen aplicado: ${pedido.descuentoAplicado} off por tarjeta</div>` : ""}
            ${pedido.proIncluido ? `<div><b>Plan Pro ${pedido.planProTipo === "anual" ? "anual" : "primer mes"}:</b> $${(pedido.planProTipo === "anual" ? PRECIO_PRO_ANUAL_COP : PRECIO_PRO_COP).toLocaleString("es-CO")} COP</div>` : ""}
          </div>
          <div class="monto">$${pedido.monto.toLocaleString("es-CO")} COP</div>

          ${pedido.proIncluido && pedido.planProTipo === "mensual" ? `
          <label style="display:flex;align-items:flex-start;gap:9px;text-align:left;font-size:0.82rem;color:${MARCA.textoSuave};
                        background:${MARCA.crema};border-radius:10px;padding:12px 14px;margin:14px 0;cursor:pointer;">
            <input type="checkbox" id="check-renovar" checked style="margin-top:2px;flex-shrink:0;">
            <span>Renovar mi Plan Pro automáticamente cada mes. Al activar la tarjeta te vamos a pedir registrar una tarjeta para el cobro — puedes cancelar cuando quieras desde tu panel.</span>
          </label>
          <script>
            document.getElementById("check-renovar").addEventListener("change", function () {
              fetch("/pedido/${req.params.id}/renovar-automatico", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ renovar: this.checked }),
              }).catch(function () {});
            });
          </script>
          ` : ""}

          <form action="https://checkout.wompi.co/p/" method="GET">
            <input type="hidden" name="public-key" value="${process.env.WOMPI_PUBLIC_KEY}" />
            <input type="hidden" name="currency" value="${moneda}" />
            <input type="hidden" name="amount-in-cents" value="${montoCentavos}" />
            <input type="hidden" name="reference" value="${referencia}" />
            <input type="hidden" name="signature:integrity" value="${firma}" />
            <input type="hidden" name="redirect-url" value="${redirectUrl}" />
            <input type="hidden" name="shipping-address:address-line-1" value="${escaparHtml(pedido.direccion || "")}" />
            <input type="hidden" name="shipping-address:city" value="${escaparHtml(pedido.ciudad || "")}" />
            <input type="hidden" name="shipping-address:region" value="${escaparHtml(pedido.departamento || "")}" />
            <input type="hidden" name="shipping-address:phone-number" value="${escaparHtml((pedido.telefono || "").replace(/\D/g, ""))}" />
            <input type="hidden" name="shipping-address:country" value="CO" />
            <input type="hidden" name="customer-data:email" value="${escaparHtml(pedido.email || "")}" />
            <input type="hidden" name="customer-data:full-name" value="${escaparHtml(pedido.nombreNegocio || "")}" />
            <button type="submit">Pagar con Wompi</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

// Wompi redirige aquí después del pago, con ?id=TRANSACTION_ID en la URL.
// Consultamos el estado real de la transacción contra la API de Wompi
// (nunca confiamos solo en lo que diga la URL, porque se podría manipular).
// La verificación de firma del webhook (verificarChecksumWompi) ya está
// definida más arriba, junto al resto de helpers de Wompi.

// Registro de referencias de pago ya facturadas en Alegra, guardado en el
// propio negocio. Existe porque el mismo pago puede llegar por DOS caminos
// casi al tiempo (el webhook de Wompi y la página de confirmación cuando el
// cliente vuelve del pago), y el webhook además puede reintentarse — sin
// esta marca, cada camino generaría su propia factura ante la DIAN.
function yaSeFacturo(negocio, referencia) {
  return Array.isArray(negocio.facturasEmitidas) && negocio.facturasEmitidas.includes(referencia);
}
// Devuelve el objeto de cambios a incluir en guardarCambiosNegocio para
// marcar la referencia como facturada (con tope para que no crezca infinito).
function marcaFacturaEmitida(negocio, referencia) {
  const lista = Array.isArray(negocio.facturasEmitidas) ? negocio.facturasEmitidas : [];
  return { facturasEmitidas: [...lista, referencia].slice(-100) };
}

// Activa (o renueva) el Plan Pro de un negocio tras un pago aprobado desde
// /mejorar-a-pro. Reutilizable desde la página de confirmación (cuando el
// cliente vuelve del pago) y desde el webhook de Wompi — volver a llamarla
// para el mismo pago no causa ningún problema: los cambios de plan solo se
// reescriben iguales, y la factura se genera una única vez gracias a la
// marca por referencia.
function activarUpgradePro(slug, esAnual, referencia) {
  const negocio = obtenerNegocio(slug);
  if (!negocio) return;
  const referenciaFactura = referencia || `tapin-upgrade-${esAnual ? "anual-" : ""}${slug}`;
  const yaFacturado = yaSeFacturo(negocio, referenciaFactura);
  const marcaFactura = yaFacturado ? {} : marcaFacturaEmitida(negocio, referenciaFactura);
  const precioPagado = esAnual ? PRECIO_PRO_ANUAL_COP : precioProSegunLocales(negocio.email, todosLosNegocios());
  if (esAnual) {
    const unAnioDespues = new Date();
    unAnioDespues.setFullYear(unAnioDespues.getFullYear() + 1);
    guardarCambiosNegocio(slug, negocio, {
      plan: "pro",
      billingType: "anual",
      proAnualHasta: unAnioDespues.toISOString(),
      ...marcaFactura,
    });
    registrarAuditoria(slug, negocio, `Mejoraste a Plan Pro anual (vence ${unAnioDespues.toLocaleDateString("es-CO")})`);
  } else {
    // Pro mensual: este primer pago ya cubre el ciclo actual. Todavía no
    // hay tarjeta tokenizada (paymentSourceId) — por eso, aunque quede
    // "activa: true" aquí, la página /suscripcion/:slug lo trata como
    // "falta registrar tarjeta" hasta que el dueño complete ese paso en
    // /suscripcion/:slug/registrar. Cuando la registre, se sobreescribe
    // este mismo objeto con su paymentSourceId real.
    guardarCambiosNegocio(slug, negocio, {
      plan: "pro",
      billingType: "mensual",
      suscripcion: {
        activa: true,
        proximoCobro: sumarUnMes(),
        ultimoPagoConfirmado: new Date().toISOString(),
      },
      ...marcaFactura,
    });
    registrarAuditoria(slug, negocio, "Mejoraste a Plan Pro");
  }

  // Factura electronica: solo la primera vez que llega esta referencia.
  // Si el negocio no dejo NIT en Configuracion, sale a consumidor final.
  // No bloquea el resto del flujo si Alegra falla o no esta configurado.
  if (!yaFacturado) {
    crearFacturaAlegra({
      nit: negocio.datosFactura && negocio.datosFactura.nit,
      razonSocial: negocio.datosFactura && negocio.datosFactura.razonSocial,
      email: negocio.email,
      items: [{ nombreItem: ALEGRA_NOMBRE_ITEM_PRO, cantidad: 1, precioUnitario: precioPagado }],
      referencia: referenciaFactura,
    }).catch((err) => console.error("[Alegra] Error inesperado facturando upgrade:", err.message));
  }
}

// Wompi le pega a esta URL automáticamente cada vez que cambia el estado de
// una transacción — así el pedido/suscripción queda al día aunque el
// cliente cierre el navegador antes de volver a tu sitio. Regístrala en
// Wompi desde comercios.wompi.co → Desarrolladores → "URL de eventos", con
// esta URL completa: https://tu-dominio.com/webhook/wompi
app.post("/webhook/wompi", async (req, res) => {
  const payload = req.body;
  if (!verificarChecksumWompi(payload)) {
    console.error("[webhook Wompi] checksum inválido o WOMPI_EVENTS_SECRET no configurado — aviso ignorado.");
    return res.status(400).json({ ok: false, motivo: "Checksum inválido." });
  }

  const transaccion = payload?.data?.transaction;
  // Solo las transacciones aprobadas requieren una acción automática de
  // nuestra parte — rechazos y pendientes no necesitan que hagamos nada aquí.
  if (!transaccion || transaccion.status !== "APPROVED") {
    return res.status(200).json({ ok: true, ignorado: true });
  }

  const referencia = transaccion.reference || "";

  try {
    if (referencia.startsWith("tapin-upgrade-anual-")) {
      // Formato: tapin-upgrade-anual-{slug}-{timestamp}. El timestamp
      // (Date.now(), solo dígitos) siempre es el último tramo, así que se
      // puede recortar sin ambigüedad aunque el slug tenga guiones.
      const partes = referencia.slice("tapin-upgrade-anual-".length).split("-");
      activarUpgradePro(partes.slice(0, -1).join("-"), true, referencia);
    } else if (referencia.startsWith("tapin-upgrade-")) {
      const partes = referencia.slice("tapin-upgrade-".length).split("-");
      activarUpgradePro(partes.slice(0, -1).join("-"), false, referencia);
    } else if (referencia.startsWith("tapin-pro-")) {
      // Formato: tapin-pro-{AAAAMM}-{slug} — el año-mes son siempre 6
      // dígitos en una posición fija, así que el slug se recorta sin
      // ambigüedad aunque tenga guiones.
      const resto = referencia.slice("tapin-pro-".length);
      const slug = resto.slice(7); // 6 dígitos del AAAAMM + 1 guion
      const negocio = obtenerNegocio(slug);
      if (negocio && negocio.suscripcion) {
        // La referencia trae el año-mes, asi que es unica por ciclo: si
        // Wompi reenvia este mismo aviso, la marca evita facturar dos veces.
        const yaFacturado = yaSeFacturo(negocio, referencia);
        guardarCambiosNegocio(slug, negocio, {
          suscripcion: { ...negocio.suscripcion, ultimoPagoConfirmado: new Date().toISOString() },
          ...(yaFacturado ? {} : marcaFacturaEmitida(negocio, referencia)),
        });
        registrarAuditoria(slug, negocio, "Pago mensual del Plan Pro confirmado");

        // Factura electronica de este ciclo. Si el negocio no dejo NIT en
        // Configuracion, sale a consumidor final. No bloquea el resto del
        // flujo si Alegra falla.
        if (!yaFacturado) {
          const precioPagado = precioProSegunLocales(negocio.email, todosLosNegocios());
          crearFacturaAlegra({
            nit: negocio.datosFactura && negocio.datosFactura.nit,
            razonSocial: negocio.datosFactura && negocio.datosFactura.razonSocial,
            email: negocio.email,
            items: [{ nombreItem: ALEGRA_NOMBRE_ITEM_PRO, cantidad: 1, precioUnitario: precioPagado }],
            referencia,
          }).catch((err) => console.error("[Alegra] Error inesperado facturando mensualidad:", err.message));
        }
      }
    } else if (referencia.startsWith("tapin-")) {
      const pedidoId = referencia.slice("tapin-".length);
      await activarPedidoAprobado(pedidoId, req);
    }
  } catch (err) {
    console.error("[webhook Wompi] Error procesando el evento:", err.message);
  }

  // Wompi solo necesita un 200 OK para saber que el aviso llegó bien.
  res.status(200).json({ ok: true });
});

// Genera los códigos de activación de un pedido ya aprobado y manda el
// correo con los links de activación. Reutilizable desde /pago-confirmado
// (cuando el cliente vuelve a la página tras pagar) y desde el webhook de
// Wompi (que puede avisar primero, o si el cliente cierra el navegador antes
// de volver). Es seguro llamarla más de una vez para el mismo pedido: si ya
// se generaron códigos antes, no hace nada — evita duplicar tarjetas o correos.
async function activarPedidoAprobado(pedidoId, req) {
  const pedidos = leerPedidos();
  const pedido = pedidos[pedidoId];
  if (!pedido) return;
  const yaGenerado = pedido.estado === "aprobado" && pedido.codigosGenerados;
  pedido.estado = "aprobado";

  if (!yaGenerado) {
    const cantidadComprada = pedido.cantidad || 1;
    const codigos = leerCodigos();
    const nuevosCodigos = [];
    for (let i = 0; i < cantidadComprada; i++) {
      let nuevo;
      do {
        nuevo = generarCodigo();
      } while (codigos[nuevo]);
      codigos[nuevo] = {
        activado: false,
        creado: new Date().toISOString(),
        proIncluido: pedido.proIncluido || false,
        planProTipo: pedido.planProTipo || null,
        renovarAutomatico: pedido.proIncluido && pedido.planProTipo === "mensual" && pedido.renovarAutomatico !== false,
        datosFactura: (pedido.nit || pedido.razonSocial) ? { nit: pedido.nit || "", razonSocial: pedido.razonSocial || "" } : null,
      };
      nuevosCodigos.push(nuevo);
    }
    guardarCodigos(codigos);
    pedido.codigosGenerados = nuevosCodigos;
    pedidos[pedidoId] = pedido;
    guardarPedidos(pedidos);

    // Factura electronica -- se dispara aqui, una sola vez por pedido,
    // junto con la generacion de codigos (el flag yaGenerado de arriba
    // evita duplicados si el webhook y /pago-confirmado llegan a la vez).
    // Si el comprador no dejo NIT, sale a nombre del consumidor final. No
    // bloquea el resto del flujo si Alegra falla o no esta configurado.
    {
      const itemsFactura = [
        { nombreItem: ALEGRA_NOMBRE_ITEM_BASICO, cantidad: cantidadComprada, precioUnitario: pedido.precioUnidad },
      ];
      if (pedido.proIncluido) {
        const precioPro = pedido.planProTipo === "anual" ? PRECIO_PRO_ANUAL_COP : PRECIO_PRO_COP;
        itemsFactura.push({ nombreItem: ALEGRA_NOMBRE_ITEM_PRO, cantidad: 1, precioUnitario: precioPro });
      }
      crearFacturaAlegra({
        nit: pedido.nit,
        razonSocial: pedido.razonSocial,
        email: pedido.email,
        items: itemsFactura,
        referencia: `tapin-${pedidoId}`,
      }).catch((err) => console.error("[Alegra] Error inesperado facturando pedido:", err.message));
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const filasCodigos = nuevosCodigos
      .map((c) => `<li style="margin-bottom:8px;"><b style="letter-spacing:0.05em;">${c}</b> — <a href="${baseUrl}/activar/${c}">Activar esta tarjeta</a></li>`)
      .join("");
    enviarEmail(
      pedido.email,
      nuevosCodigos.length === 1 ? "Tu código de activación Tapin" : `Tus ${nuevosCodigos.length} códigos de activación Tapin`,
      `<div style="font-family:-apple-system,Arial,sans-serif;max-width:460px;">
         <h2 style="color:${MARCA.verdeOscuro};">¡Gracias por tu compra, ${pedido.nombreNegocio}!</h2>
         <p>Tu pago fue aprobado. Cuando te llegue${nuevosCodigos.length > 1 ? "n" : ""} la${nuevosCodigos.length > 1 ? "s" : ""} tarjeta${nuevosCodigos.length > 1 ? "s" : ""} física${nuevosCodigos.length > 1 ? "s" : ""}, activa cada una con su link:</p>
         <ul style="padding-left:18px;">${filasCodigos}</ul>
         <p style="font-size:0.8rem;color:#888;">Si tienes más de una tarjeta, usa el mismo correo al activarlas para verlas todas juntas en <a href="${baseUrl}/mis-negocios">tu panel</a>.</p>
       </div>`
    ).catch((err) => console.error("[pago-confirmado] Error enviando códigos:", err.message));
  } else {
    pedidos[pedidoId] = pedido;
    guardarPedidos(pedidos);
  }
}

app.get("/pago-confirmado", async (req, res) => {
  const pedidoId = req.query.pedido;
  const transaccionId = req.query.id;
  const pedidos = leerPedidos();
  const pedido = pedidos[pedidoId];

  let estado = "desconocido";
  let mensaje = "No pudimos confirmar el estado de tu pago automáticamente.";

  if (transaccionId && process.env.WOMPI_PUBLIC_KEY) {
    try {
      const resp = await fetch(`${baseWompi()}/transactions/${transaccionId}`);
      const data = await resp.json();
      estado = data?.data?.status || "desconocido";
    } catch (err) {
      console.error("Error consultando la transacción en Wompi:", err.message);
    }
  }

  if (pedido) {
    if (estado === "APPROVED") {
      mensaje = pedido.proIncluido
        ? "¡Pago aprobado! Tu tarjeta Tapin va en camino, con tu primer mes de Plan Pro ya incluido."
        : "¡Pago aprobado! Tu tarjeta Tapin va en camino.";
      await activarPedidoAprobado(pedidoId, req);
    } else if (estado === "DECLINED" || estado === "ERROR" || estado === "VOIDED") {
      pedido.estado = "rechazado";
      mensaje = "El pago no pudo procesarse. Puedes intentar de nuevo.";
      pedidos[pedidoId] = pedido;
      guardarPedidos(pedidos);
    } else if (estado === "PENDING") {
      mensaje = "Tu pago está siendo procesado. Te avisamos por correo cuando se confirme.";
    }
  }

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Confirmación de pago — Tapin</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.crema};
               margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
          .box{background:#fff;border-radius:18px;padding:34px 30px;max-width:400px;width:100%;text-align:center;
               box-shadow:0 10px 40px rgba(0,0,0,0.08);}
          h1{font-size:1.15rem;color:${MARCA.texto};margin:16px 0 8px;}
          p{color:${MARCA.textoSuave};font-size:0.88rem;}
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 26)}</div>
          <h1>${mensaje}</h1>
          <p>Si tienes dudas sobre tu pedido, contáctanos con tu correo de referencia.</p>
        </div>
      </body>
    </html>
  `);
});

// ---------- Mejorar a Pro pagando directamente desde el panel ----------
// Un negocio en Plan Básico puede pagar su primer mes de Pro sin que Samuel
// tenga que activarlo a mano. Usa el mismo Web Checkout que /pagar/:id.
app.get("/mejorar-a-pro/:slug", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) {
    return res.status(401).send("No autorizado.");
  }
  // Si ya es Pro, normalmente lo mandamos a su panel — pero si está pidiendo
  // renovar el anual explícitamente (?plan=anual), lo dejamos pasar, para que
  // pueda renovar antes de que venza sin tener que esperar a quedarse sin Pro.
  if (esPro(negocio) && req.query.plan !== "anual") {
    return res.redirect(`/mi-panel/${slug}?key=${req.query.key}`);
  }
  if (!process.env.WOMPI_PUBLIC_KEY || !process.env.WOMPI_INTEGRITY_SECRET) {
    return res.status(500).send("Los pagos todavía no están configurados. Contacta a Tapin.");
  }

  const moneda = "COP";
  const esAnual = req.query.plan === "anual";

  // El precio MENSUAL depende de cuántas tarjetas en Pro va a tener el
  // negocio DESPUÉS de esta mejora (los que ya tiene + este nuevo). El
  // ANUAL es un precio fijo, pago único, sin importar cuántas tarjetas tenga.
  const todosNegociosUpgrade = todosLosNegocios();
  const correoUpgrade = (negocio.email || "").trim().toLowerCase();
  const localesProExistentes = Object.values(todosNegociosUpgrade).filter(
    (n) => esPro(n) && (n.email || "").trim().toLowerCase() === correoUpgrade
  ).length;
  const totalLocalesTrasUpgrade = localesProExistentes + 1;
  const escalonUpgrade = ESCALONES_PRO.find((e) => totalLocalesTrasUpgrade >= e.minimo) || ESCALONES_PRO[ESCALONES_PRO.length - 1];
  const precioProAplicable = esAnual ? PRECIO_PRO_ANUAL_COP : escalonUpgrade.precio;
  const montoCentavos = precioProAplicable * 100;
  const referencia = `tapin-upgrade-${esAnual ? "anual-" : ""}${slug}-${Date.now()}`;
  const firma = firmaIntegridadWompi(referencia, montoCentavos, moneda);
  const redirectUrl = `${req.protocol}://${req.get("host")}/mejorar-a-pro/${slug}/confirmar?key=${req.query.key}`;

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Mejorar a Pro — ${negocio.nombre}</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.crema};
               margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
          .box{background:#fff;border-radius:18px;padding:34px 30px;max-width:420px;width:100%;text-align:center;
               box-shadow:0 10px 40px rgba(0,0,0,0.08);}
          h1{font-size:1.1rem;color:${MARCA.texto};margin:14px 0 10px;}
          p{color:${MARCA.textoSuave};font-size:0.85rem;}
          ul{text-align:left;font-size:0.85rem;color:${MARCA.texto};margin:16px 0;padding-left:20px;line-height:1.7;}
          .monto{font-size:1.6rem;font-weight:800;color:${MARCA.verde};margin:14px 0;}
          button{width:100%;background:${MARCA.verde};color:#fff;border:none;padding:14px;border-radius:10px;
                 font-weight:700;font-size:0.95rem;cursor:pointer;margin-top:6px;}
          .volver{display:inline-block;margin-top:16px;font-size:0.8rem;color:${MARCA.textoSuave};}
          .toggle-plan{display:flex;background:${MARCA.crema};border-radius:10px;padding:4px;margin:16px 0;}
          .toggle-plan a{flex:1;text-align:center;padding:9px 0;border-radius:8px;font-size:0.82rem;font-weight:700;
                         text-decoration:none;color:${MARCA.textoSuave};}
          .toggle-plan a.activo{background:${MARCA.verdeOscuro};color:#fff;}
          .ahorro-badge{display:inline-block;background:${MARCA.oro};color:#fff;font-size:0.68rem;font-weight:800;
                        padding:3px 10px;border-radius:100px;margin-left:6px;vertical-align:middle;}
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 26)}</div>
          <h1>Mejora ${negocio.nombre} a Plan Pro</h1>

          <div class="toggle-plan">
            <a href="/mejorar-a-pro/${slug}?key=${req.query.key}" class="${!esAnual ? "activo" : ""}">Mensual</a>
            <a href="/mejorar-a-pro/${slug}?key=${req.query.key}&plan=anual" class="${esAnual ? "activo" : ""}">Anual</a>
          </div>

          ${esAnual
            ? `<p>Pagas una sola vez y quedas activo los próximos 12 meses — sin cobros automáticos ni tarjeta que registrar.</p>`
            : `<p>Pagas el primer mes ahora y queda activo de inmediato. Los meses siguientes se cobran automáticamente a la tarjeta que registres después de este pago.</p>`}
          <ul>
            <li>Gráfica de horas pico</li>
            <li>Reputación: positivas vs. quejas privadas</li>
            <li>Actividad reciente al detalle</li>
            <li>Recomendaciones automáticas</li>
            <li>Alertas instantáneas y exportes</li>
          </ul>
          <div class="monto">
            $${precioProAplicable.toLocaleString("es-CO")} COP<span style="font-size:0.9rem;font-weight:600;color:${MARCA.textoSuave};">${esAnual ? "/año" : "/mes"}</span>
            ${esAnual ? `<span class="ahorro-badge">10% más barato</span>` : ""}
          </div>
          ${!esAnual && totalLocalesTrasUpgrade >= 4 ? `<p style="font-size:0.78rem;color:${MARCA.oro};">Esta es tu ${totalLocalesTrasUpgrade}ª tarjeta en Plan Pro — aplica la tarifa de ${totalLocalesTrasUpgrade} o más tarjetas.</p>` : ""}

          <form action="https://checkout.wompi.co/p/" method="GET">
            <input type="hidden" name="public-key" value="${process.env.WOMPI_PUBLIC_KEY}" />
            <input type="hidden" name="currency" value="${moneda}" />
            <input type="hidden" name="amount-in-cents" value="${montoCentavos}" />
            <input type="hidden" name="reference" value="${referencia}" />
            <input type="hidden" name="signature:integrity" value="${firma}" />
            <input type="hidden" name="redirect-url" value="${redirectUrl}" />
            <input type="hidden" name="customer-data:email" value="${escaparHtml(negocio.email || "")}" />
            <input type="hidden" name="customer-data:full-name" value="${escaparHtml(negocio.nombre || "")}" />
            <button type="submit">Pagar y activar Pro</button>
          </form>
          <a class="volver" href="/mi-panel/${slug}?key=${req.query.key}">&larr; Volver a mi panel</a>
        </div>
      </body>
    </html>
  `);
});

// Confirma el pago de la mejora a Pro: consulta el estado real en Wompi (nunca
// confía en el query string por sí solo), y si fue aprobado, activa el plan
// Pro del negocio y lo manda a registrar su tarjeta para el cobro mensual.
app.get("/mejorar-a-pro/:slug/confirmar", async (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) {
    return res.status(401).send("No autorizado.");
  }

  const transaccionId = req.query.id;
  let estado = "desconocido";

  if (transaccionId && process.env.WOMPI_PUBLIC_KEY) {
    try {
      const resp = await fetch(`${baseWompi()}/transactions/${transaccionId}`);
      const data = await resp.json();
      estado = data?.data?.status || "desconocido";
      const referenciaRecibida = data?.data?.reference || "";
      const esAnual = referenciaRecibida.startsWith(`tapin-upgrade-anual-${slug}-`);
      const referenciaOk = esAnual || referenciaRecibida.startsWith(`tapin-upgrade-${slug}-`);
      const montoOk = esAnual
        ? data?.data?.amount_in_cents === PRECIO_PRO_ANUAL_COP * 100
        : ESCALONES_PRO.some((e) => data?.data?.amount_in_cents === e.precio * 100);
      if (estado === "APPROVED" && referenciaOk && montoOk) {
        activarUpgradePro(slug, esAnual, referenciaRecibida);
      }
    } catch (err) {
      console.error("[mejorar-a-pro] Error consultando la transacción en Wompi:", err.message);
    }
  }

  const negocioActualizado = obtenerNegocio(slug);
  const yaEsPro = esPro(negocioActualizado);

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Confirmación — ${negocio.nombre}</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.crema};
               margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
          .box{background:#fff;border-radius:18px;padding:34px 30px;max-width:400px;width:100%;text-align:center;
               box-shadow:0 10px 40px rgba(0,0,0,0.08);}
          h1{font-size:1.15rem;color:${MARCA.texto};margin:16px 0 8px;}
          p{color:${MARCA.textoSuave};font-size:0.88rem;}
          a.boton{display:inline-block;margin-top:16px;background:${MARCA.verde};color:#fff;text-decoration:none;
                  padding:12px 20px;border-radius:10px;font-weight:700;font-size:0.88rem;}
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 26)}</div>
          ${yaEsPro
            ? (negocioActualizado.billingType === "anual"
                ? `<h1>¡Listo! ${negocio.nombre} ya está en Plan Pro.</h1>
                   <p>Pagaste el año completo — queda activo hasta el ${new Date(negocioActualizado.proAnualHasta).toLocaleDateString("es-CO")}, sin cobros automáticos ni tarjeta que registrar.</p>
                   <a class="boton" href="/mi-panel/${slug}?key=${req.query.key}">Ir a mi panel</a>`
                : `<h1>¡Listo! ${negocio.nombre} ya está en Plan Pro.</h1>
                   <p>Ahora registra tu tarjeta para que el cobro de los próximos meses sea automático.</p>
                   <a class="boton" href="/suscripcion/${slug}?key=${req.query.key}">Registrar tarjeta para el cobro mensual</a>`)
            : estado === "PENDING"
              ? `<h1>Tu pago está siendo procesado</h1><p>En unos minutos se activa el Plan Pro. Te avisamos por correo.</p>`
              : `<h1>No pudimos confirmar el pago</h1><p>Si ya pagaste, espera un momento y recarga esta página. Si el pago falló, puedes intentarlo de nuevo.</p>
                 <a class="boton" href="/mejorar-a-pro/${slug}?key=${req.query.key}">Intentar de nuevo</a>`}
        </div>
      </body>
    </html>
  `);
});


// El Plan Pro mensual se renueva con cobro automático silencioso de
// verdad: el dueño registra su tarjeta UNA vez (se tokeniza con Wompi,
// Tapin nunca ve ni guarda el número real), y cada mes el servidor le
// cobra directamente a esa "fuente de pago" vía la API de Wompi — sin que
// nadie tenga que volver a hacer nada. Si el cobro falla (tarjeta vencida,
// fondos insuficientes, etc.) no reintentamos solos ni bajamos el plan de
// inmediato: se avisa por correo y queda visible en el panel para decidir
// a mano. Ver /cobrar-suscripciones más abajo para el cron mensual.
function sumarUnMes(fechaISO) {
  const f = fechaISO ? new Date(fechaISO) : new Date();
  f.setMonth(f.getMonth() + 1);
  return f.toISOString();
}
// Guarda cambios sobre un negocio siguiendo el mismo patrón que /editar/:slug:
// si el negocio venía fijo en NEGOCIOS (no en codigos.json), crea el override
// ahí para poder persistir el dato sin tocar server.js ni redesplegar.
function guardarCambiosNegocio(slug, negocio, cambios) {
  const codigos = leerCodigos();
  if (!codigos[slug]) codigos[slug] = { activado: true, creado: new Date().toISOString() };
  codigos[slug].activado = true;
  codigos[slug].negocio = { ...negocio, ...cambios };
  guardarCodigos(codigos);
}

// Idea 22: registro simple de cambios importantes en tu propia cuenta — no
// es auditoría de nadie más, solo tu propio historial para tener orden.
function registrarAuditoria(slug, negocio, texto) {
  const datos = leerDatos();
  if (!datos[slug]) datos[slug] = { total: 0, eventos: [] };
  if (!datos[slug].auditoria) datos[slug].auditoria = [];
  datos[slug].auditoria.push({
    texto,
    fechaLegible: new Date().toLocaleString("es-CO", { timeZone: zonaDe(negocio), day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
  });
  guardarDatos(datos);
}

// Auditoría a nivel de TODO el sistema (no de un solo negocio) — para
// acciones que solo el administrador puede hacer: crear/quitar negocios,
// generar códigos, cambiar planes a mano. Antes no quedaba ningún rastro de
// quién hizo qué cambio administrativo ni cuándo.
const AUDITORIA_GLOBAL_FILE = path.join(DATA_DIR, "auditoria-global.json");
function registrarAuditoriaGlobal(accion, detalle, req) {
  let registros = [];
  try {
    if (fs.existsSync(AUDITORIA_GLOBAL_FILE)) registros = JSON.parse(fs.readFileSync(AUDITORIA_GLOBAL_FILE, "utf8"));
  } catch {
    registros = [];
  }
  registros.push({
    accion,
    detalle,
    ip: req ? req.ip : null,
    fechaISO: new Date().toISOString(),
    fechaLegible: new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" }),
  });
  if (registros.length > 5000) registros = registros.slice(-5000); // no crece sin control
  fs.writeFileSync(AUDITORIA_GLOBAL_FILE, JSON.stringify(registros, null, 2));
}

// Página donde el dueño de un negocio Pro registra su tarjeta (tokenizada
// con el widget de Wompi) para el cobro automático mensual, o ve el estado
// de la que ya tiene registrada, la cancela, o la reemplaza por otra.
app.get("/suscripcion/:slug", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return enviarError(res, 404, "No encontramos este negocio", "Revisa que el enlace esté completo y bien escrito.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) {
    return enviarError(res, 401, "No pudimos verificar tu acceso", "El enlace debe incluir tu clave personal (?key=...).");
  }
  if (!esPro(negocio)) {
    return enviarError(res, 402, "Esto es exclusivo del Plan Pro", "Esta página de suscripción solo aplica para negocios en Plan Pro.", { texto: "Ver planes", href: `/mejorar-a-pro/${slug}?key=${req.query.key}` });
  }

  const sus = negocio.suscripcion;
  const activa = !!(sus && sus.activa && sus.paymentSourceId);
  const cancelada = !!(sus && !sus.activa && sus.vigenteHasta);
  const esAnual = negocio.billingType === "anual";
  const precioProAplicable = precioProSegunLocales(negocio.email, todosLosNegocios());

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Suscripción Pro — ${negocio.nombre}</title>
        <style>
          *{box-sizing:border-box;}
          @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600;1,700&display=swap');
          :root{--ink:#062e1e;--forest:#0d432b;--cream:#fbf6e9;--muted:#50695b;--line:#dedccc;--gold:#e8a623;}
          body{font-family:'DM Sans','Segoe UI',-apple-system,Arial,sans-serif;background:var(--cream);
               margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
          .box{background:#fff;border-radius:24px;padding:38px 34px;max-width:440px;width:100%;text-align:center;
               box-shadow:0 20px 50px rgba(9,49,30,.1);border:1px solid var(--line);}
          h1{font-family:'Playfair Display',Georgia,serif;font-size:1.5rem;color:var(--ink);margin:16px 0 4px;letter-spacing:-.02em;}
          p{color:var(--muted);font-size:0.9rem;line-height:1.55;}
          .estado{padding:14px 18px;border-radius:14px;font-weight:700;margin:18px 0;font-size:0.85rem;}
          .estado.ok{background:#e7f0ea;color:var(--forest);}
          .estado.cancelada{background:#fff4e0;color:#8a5a00;}
          .btn{display:inline-block;width:100%;border-radius:999px;padding:14px 20px;font-weight:700;font-size:.9rem;
               text-decoration:none;cursor:pointer;border:none;box-sizing:border-box;margin-top:10px;}
          .btn-principal{background:var(--gold);color:var(--ink);box-shadow:0 10px 20px rgba(232,166,35,.28);}
          .btn-secundario{background:#fff;color:var(--ink);border:1.5px solid var(--line);}
          .btn-peligro{background:#fff;color:#a83a2b;border:1.5px solid #f0d0c8;}
          .divisor{height:1px;background:var(--line);margin:22px 0;}
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 34)}</div>
          <h1>Suscripción Plan Pro</h1>
          <p style="margin-top:-6px;">${negocio.nombre}</p>

          ${esAnual ? `
            <div class="estado ok">Plan Pro anual — pago único, sin cobros automáticos.</div>
            <p>Vence el <b>${negocio.proAnualHasta ? new Date(negocio.proAnualHasta).toLocaleDateString("es-CO") : "—"}</b>. Como ya pagaste el año completo, no hay nada que cobrar ni cancelar — simplemente no se renueva sola cuando termine, a menos que vuelvas a pagar.</p>
            <p style="font-size:0.78rem;">¿Quieres bajar a Plan Básico antes de esa fecha de todas formas?</p>
            <form method="POST" action="/suscripcion/${slug}/bajar-anticipado?key=${req.query.key}" onsubmit="return confirm('¿Seguro que quieres bajar a Plan Básico ahora? Pierdes el resto de tu Plan Pro anual ya pagado, no se reembolsa.');">
              <button type="submit" class="btn btn-peligro">Bajar a Plan Básico ahora</button>
            </form>
          ` : activa ? `
            <div class="estado ok">Tarjeta registrada. Se cobra automáticamente $${precioProAplicable.toLocaleString("es-CO")} COP cada mes.</div>
            <p>Próximo cobro: <b>${sus.proximoCobro ? new Date(sus.proximoCobro).toLocaleDateString("es-CO") : "pendiente"}</b></p>
            <p style="font-size:0.8rem;">¿Cambiaste de tarjeta? Registra una nueva abajo y reemplaza la anterior.</p>
            <form method="POST" action="/suscripcion/${slug}/registrar?key=${req.query.key}">
              <script src="https://checkout.wompi.co/widget.js" data-render="button" data-widget-operation="tokenize" data-public-key="${process.env.WOMPI_PUBLIC_KEY || ""}"></script>
            </form>
            <div class="divisor"></div>
            <form method="POST" action="/suscripcion/${slug}/cancelar?key=${req.query.key}" onsubmit="return confirm('¿Seguro que quieres cancelar? Sigues teniendo Pro hasta el ${sus.proximoCobro ? new Date(sus.proximoCobro).toLocaleDateString("es-CO") : "final del período ya pagado"}, después bajas a Básico automáticamente, sin cobros nuevos.');">
              <button type="submit" class="btn btn-peligro">Cancelar suscripción</button>
            </form>
          ` : cancelada ? `
            <div class="estado cancelada">Cancelada — sigues en Pro hasta el <b>${new Date(sus.vigenteHasta).toLocaleDateString("es-CO")}</b>, después bajas a Básico sola, sin que hagas nada más.</div>
            <p>¿Cambiaste de opinión? Vuelve a registrar tu tarjeta para seguir en Pro sin interrupción.</p>
            <form method="POST" action="/suscripcion/${slug}/registrar?key=${req.query.key}">
              <script src="https://checkout.wompi.co/widget.js" data-render="button" data-widget-operation="tokenize" data-public-key="${process.env.WOMPI_PUBLIC_KEY || ""}"></script>
            </form>
          ` : `
            <p>Registra tu tarjeta una sola vez. <b>No se te cobra nada en este paso</b> — solo queda guardada para el cobro automático de $${precioProAplicable.toLocaleString("es-CO")} COP/mes.</p>
            <form method="POST" action="/suscripcion/${slug}/registrar?key=${req.query.key}">
              <script src="https://checkout.wompi.co/widget.js" data-render="button" data-widget-operation="tokenize" data-public-key="${process.env.WOMPI_PUBLIC_KEY || ""}"></script>
            </form>
          `}

          <a class="btn btn-secundario" href="/mi-panel/${slug}?key=${req.query.key}" style="margin-top:18px;">&larr; Volver a mi panel</a>
        </div>
      </body>
    </html>
  `);
});

// Recibe el token de la tarjeta (nunca el número real) desde el widget de
// Wompi y crea una "fuente de pago" (payment source): un identificador
// reutilizable que el servidor usa cada mes para cobrar esa tarjeta
// directamente vía API, sin que el dueño del negocio vuelva a intervenir.
app.post("/suscripcion/:slug/registrar", async (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) {
    return res.status(401).send("No autorizado.");
  }
  if (!process.env.WOMPI_PRIVATE_KEY) {
    return res.status(500).send("Falta configurar WOMPI_PRIVATE_KEY en Render (tu Llave privada de Wompi, no la pública).");
  }
  const wompiToken = req.body["wompi-token"];
  if (!wompiToken) {
    return res.status(400).send("No llegó el token de la tarjeta desde Wompi. Intenta de nuevo.");
  }

  try {
    const base = baseWompi();
    // 1. Pedimos los tokens de aceptación de términos y tratamiento de datos
    //    (Wompi los exige para crear una fuente de pago).
    const infoComercio = await fetch(`${base}/merchants/${process.env.WOMPI_PUBLIC_KEY}`).then((r) => r.json());
    const acceptanceToken = infoComercio?.data?.presigned_acceptance?.acceptance_token;
    const authToken = infoComercio?.data?.presigned_personal_data_auth?.acceptance_token;

    // 2. Creamos la fuente de pago con el token de la tarjeta.
    const resp = await fetch(`${base}/payment_sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.WOMPI_PRIVATE_KEY}` },
      body: JSON.stringify({
        type: "CARD",
        token: wompiToken,
        customer_email: negocio.email,
        acceptance_token: acceptanceToken,
        accept_personal_auth: authToken,
      }),
    });
    const data = await resp.json();
    const paymentSourceId = data?.data?.id;
    if (!paymentSourceId) {
      console.error("[suscripción] Wompi no devolvió payment_source:", JSON.stringify(data));
      return res.status(502).send("Wompi no pudo guardar la tarjeta. Intenta de nuevo o revisa que la tarjeta sea válida.");
    }

    guardarCambiosNegocio(slug, negocio, {
      suscripcion: { paymentSourceId, activa: true, proximoCobro: sumarUnMes(), ultimoCobro: null, ultimoError: null },
    });
    registrarAuditoria(slug, negocio, "Registraste tu tarjeta para el cobro automático del Plan Pro");

    res.redirect(`/suscripcion/${slug}?key=${req.query.key}`);
  } catch (err) {
    console.error("[suscripción] Error registrando tarjeta:", err.message);
    res.status(500).send("Ocurrió un error guardando la tarjeta. Intenta de nuevo.");
  }
});

// Cancela la suscripción mensual: deja de cobrar en el futuro, pero el
// negocio sigue en Pro hasta el final de lo que ya pagó (vigenteHasta =
// la fecha del próximo cobro que ya no va a pasar). Después de esa fecha,
// esPro() lo baja a Básico solo, sin que nadie tenga que hacer nada más.
app.post("/suscripcion/:slug/cancelar", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) {
    return res.status(401).send("No autorizado.");
  }
  const sus = negocio.suscripcion;
  if (!sus || !sus.activa) {
    return res.redirect(`/suscripcion/${slug}?key=${req.query.key}`);
  }
  guardarCambiosNegocio(slug, negocio, {
    suscripcion: { ...sus, activa: false, vigenteHasta: sus.proximoCobro || new Date().toISOString() },
  });
  registrarAuditoria(slug, negocio, `Cancelaste tu suscripción Pro (sigues activo hasta ${sus.proximoCobro ? new Date(sus.proximoCobro).toLocaleDateString("es-CO") : "hoy"})`);
  res.redirect(`/suscripcion/${slug}?key=${req.query.key}`);
});

// Baja a Básico de inmediato a un negocio con Plan Pro anual, antes de que
// se cumpla el año que ya pagó — sin reembolso (ya se explica en el botón).
// Es la excepción: en todo lo demás, el anual no tiene nada que "cancelar"
// porque no cobra solo, es un pago único que ya se hizo.
app.post("/suscripcion/:slug/bajar-anticipado", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!tieneClaveConfigurada(negocio) || !claveNegocioValida(negocio, slug, req.query.key)) {
    return res.status(401).send("No autorizado.");
  }
  if (negocio.billingType !== "anual") {
    return res.status(400).send("Esto es solo para negocios con Plan Pro anual.");
  }
  guardarCambiosNegocio(slug, negocio, { plan: "basico" });
  registrarAuditoria(slug, negocio, "Bajaste a Plan Básico antes de que terminara tu Plan Pro anual");
  res.redirect(`/mi-panel/${slug}?key=${req.query.key}`);
});

// precio que le corresponde a CADA local, según la tabla de escalones.
function precioProSegunLocales(email, todosNegocios) {
  if (!email) return PRECIO_PRO_COP;
  const correo = email.trim().toLowerCase();
  const totalLocalesPro = Object.values(todosNegocios).filter(
    (n) => esPro(n) && (n.email || "").trim().toLowerCase() === correo
  ).length;
  const escalon = ESCALONES_PRO.find((e) => totalLocalesPro >= e.minimo);
  return (escalon || ESCALONES_PRO[ESCALONES_PRO.length - 1]).precio;
}

// Arma la referencia de pago de un ciclo mensual del Plan Pro. Formato:
// tapin-pro-{AAAAMM}-{slug} — el año-mes SIEMPRE ocupa 6 dígitos justo
// después del prefijo, así que el webhook puede recortar el slug sin
// ambigüedad aunque el slug tenga guiones.
// Arma la referencia de pago de un ciclo mensual del Plan Pro. Formato:
// tapin-pro-{AAAAMM}-{slug} — el año-mes SIEMPRE ocupa 6 dígitos justo
// después del prefijo, así que el webhook de Wompi puede recortar el slug
// sin ambigüedad aunque el slug tenga guiones (ver /webhook/wompi).
function referenciaCicloProMensual(slug, fecha = new Date()) {
  const aaaamm = `${fecha.getFullYear()}${String(fecha.getMonth() + 1).padStart(2, "0")}`;
  return `tapin-pro-${aaaamm}-${slug}`;
}

// Cobro automático mensual de verdad: cobra directamente a la tarjeta
// tokenizada (payment_source_id) de cada negocio Pro mensual al que ya le
// toca el próximo ciclo — sin correos, sin links, sin que el dueño tenga
// que hacer nada. Visítala con un cron diario (por ejemplo con
// cron-job.org o el propio "Cron Jobs" de Render) — solo cobra a quien
// realmente le toque ese día:
// https://tu-dominio.com/cobrar-suscripciones?key=TU_CLAVE_ADMIN
// Si el cobro falla (tarjeta vencida, fondos insuficientes, etc.) no
// reintentamos solos ni bajamos el plan de inmediato — solo se avisa por
// correo y queda registrado el error, para decidir a mano si dar un plazo.
app.get("/cobrar-suscripciones", limitarIntentosAdmin, async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("No autorizado.");
  if (!process.env.WOMPI_PRIVATE_KEY) {
    return res.status(500).send("Falta configurar WOMPI_PRIVATE_KEY en Render.");
  }

  const negocios = todosLosNegocios();
  const base = baseWompi();
  const hoy = new Date();
  const resultado = [];

  for (const slug in negocios) {
    const negocio = negocios[slug];
    if (!esPro(negocio)) continue;
    const sus = negocio.suscripcion;
    if (!sus || !sus.activa || !sus.paymentSourceId) continue;
    if (sus.proximoCobro && new Date(sus.proximoCobro) > hoy) continue; // todavía no toca

    const precioAplicable = precioProSegunLocales(negocio.email, negocios);
    const referencia = referenciaCicloProMensual(slug, hoy);
    const montoCentavos = precioAplicable * 100;
    const firma = firmaIntegridadWompi(referencia, montoCentavos, "COP");

    try {
      const resp = await fetch(`${base}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.WOMPI_PRIVATE_KEY}` },
        body: JSON.stringify({
          amount_in_cents: montoCentavos,
          currency: "COP",
          customer_email: negocio.email,
          payment_method: { type: "CARD", installments: 1 },
          payment_source_id: sus.paymentSourceId,
          reference: referencia,
          signature: firma,
        }),
      });
      const data = await resp.json();
      const estado = data?.data?.status || "ERROR";

      if (estado === "APPROVED" || estado === "PENDING") {
        guardarCambiosNegocio(slug, negocio, {
          suscripcion: { ...sus, ultimoCobro: new Date().toISOString(), proximoCobro: sumarUnMes(sus.proximoCobro), ultimoError: null },
        });
        resultado.push({ slug, estado, precioAplicado: precioAplicable });
      } else {
        // No reintentamos solos ni desactivamos el plan automáticamente —
        // solo avisamos, para que decidas manualmente si le das un plazo o no.
        guardarCambiosNegocio(slug, negocio, {
          suscripcion: { ...sus, ultimoCobro: new Date().toISOString(), ultimoError: estado },
        });
        resultado.push({ slug, estado: `FALLÓ (${estado})` });
        const tokenSuscripcion = generarLinkAccesoNegocio(slug, 10);
        await enviarEmail(
          negocio.email,
          "No pudimos procesar tu suscripción Pro de Tapin",
          `<p>Intentamos cobrar tu mensualidad del Plan Pro y la tarjeta registrada fue rechazada (estado: ${estado}).</p>
           <p>Por favor registra una tarjeta válida aquí: ${req.protocol}://${req.get("host")}/suscripcion/${slug}?key=${tokenSuscripcion}</p>`
        );
      }
    } catch (err) {
      console.error(`[cobrar-suscripciones] Error con ${slug}:`, err.message);
      resultado.push({ slug, estado: "ERROR_SERVIDOR" });
    }
  }

  res.json({ ok: true, procesados: resultado.length, detalle: resultado });
});

// ---------- SEO técnico ----------
// El favicon (ícono que sale en la pestaña del navegador) — el navegador lo
// pide solo en /favicon.ico sin que haga falta ningún <link> en cada página.
// Reutiliza el mismo logo SVG oficial que ya está en todo el sitio, sobre un
// círculo verde de fondo para que se vea bien en pestañas claras y oscuras.
function faviconSvg() {
  const escala = 0.034; // ajusta el logo (945x355 aprox) a un tamaño cómodo dentro del círculo
  const anchoLogo = LOGO_ANCHO_VB * escala;
  const altoLogo = LOGO_ALTO_VB * escala;
  return `<svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <circle cx="32" cy="32" r="32" fill="${MARCA.verdeOscuro}"/>
    <g transform="translate(${32 - anchoLogo / 2},${32 - altoLogo / 2}) scale(${escala})">
      <g transform="translate(-44.532706,477.996311) scale(0.100000,-0.100000)" fill="#FFFFFF" stroke="none">
        ${LOGO_PATH_DATA}
      </g>
    </g>
  </svg>`;
}
app.get("/favicon.ico", (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(faviconSvg());
});
app.get("/favicon.svg", (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(faviconSvg());
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    `User-agent: *\n` +
    `Allow: /\n` +
    `Disallow: /mi-panel\n` +
    `Disallow: /editar\n` +
    `Disallow: /stats\n` +
    `Disallow: /codigos\n` +
    `Disallow: /admin\n` +
    `Disallow: /activar\n` +
    `Disallow: /cuenta\n` +
    `Disallow: /mis-negocios\n` +
    `Sitemap: https://tapincol.com/sitemap.xml\n`
  );
});

app.get("/sitemap.xml", (req, res) => {
  const paginas = ["/", "/conoce", "/descubre", "/cliente", "/mis-negocios", "/pedido", "/privacidad", "/terminos"];
  const urls = paginas
    .map((p) => `<url><loc>https://tapincol.com${p}</loc></url>`)
    .join("\n  ");
  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  ${urls}\n</urlset>`
  );
});


app.get("/privacidad", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Política de Privacidad — Tapin</title>
        <style>
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.crema};
               color:${MARCA.texto};margin:0;line-height:1.65;}
          .topbar{background:${MARCA.verdeOscuro};padding:18px 32px;}
          .contenido{max-width:720px;margin:0 auto;padding:48px 24px 80px;}
          h1{font-size:1.6rem;color:${MARCA.verdeOscuro};}
          h2{font-size:1.05rem;color:${MARCA.verdeOscuro};margin-top:32px;}
          p,li{font-size:0.92rem;color:${MARCA.texto};}
          .fecha{color:${MARCA.textoSuave};font-size:0.85rem;margin-bottom:32px;}
          a{color:${MARCA.verde};}
        </style>
      </head>
      <body>
        <div class="topbar">${logoSvg("#FFFFFF", 28)}</div>
        <div class="contenido">
          <h1>Política de Privacidad</h1>
          <div class="fecha">Última actualización: ${new Date().toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" })}</div>

          <p>En Tapin ("nosotros") respetamos tu privacidad y la de tus clientes. Este documento explica qué datos personales recogemos, para qué los usamos, y qué derechos tienes sobre ellos, en cumplimiento de la Ley 1581 de 2012 (Ley de Protección de Datos Personales de Colombia) y sus decretos reglamentarios.</p>

          <h2>1. ¿Qué datos recogemos?</h2>
          <ul>
            <li><b>De los negocios:</b> nombre del negocio, correo electrónico, dirección, categoría, enlace de reseñas de Google, y datos de facturación procesados por nuestro proveedor de pagos (Wompi) y, si el negocio solicita factura electrónica, por nuestro proveedor tecnológico autorizado por la DIAN (Alegra).</li>
            <li><b>De los clientes finales que califican con la tarjeta:</b> calificación (1-5), comentario opcional (si la calificación es negativa), teléfono (opcional), fecha, hora, y tipo de dispositivo. No pedimos ni guardamos nombres de clientes finales salvo que decidan crear una cuenta de usuario.</li>
            <li><b>De usuarios registrados (clientes con cuenta):</b> nombre, correo, y contraseña (guardada de forma cifrada, nunca en texto plano).</li>
          </ul>

          <h2>2. ¿Para qué usamos estos datos?</h2>
          <ul>
            <li>Operar el servicio: redirigir calificaciones positivas a Google, mostrar retroalimentación privada al negocio correspondiente.</li>
            <li>Generar estadísticas y reportes para el negocio (horas pico, tendencias, comparación con su categoría).</li>
            <li>Enviar alertas y reportes por correo a los negocios.</li>
            <li>Procesar pagos y suscripciones a través de Wompi, y generar facturas electrónicas ante la DIAN a través de Alegra cuando el negocio lo solicita.</li>
            <li>Mejorar el servicio y dar soporte.</li>
          </ul>

          <h2>3. ¿Con quién compartimos tus datos?</h2>
          <p>No vendemos ni compartimos tus datos personales con terceros para fines de mercadeo. Compartimos información únicamente con proveedores necesarios para operar el servicio: Wompi (pagos), Alegra (facturación electrónica ante la DIAN, solo si el negocio la solicita), y proveedores de infraestructura (hosting de correo y servidores). Estos proveedores solo acceden a lo estrictamente necesario para prestar su servicio.</p>

          <h2>4. ¿Cómo protegemos tus datos?</h2>
          <p>Los datos se almacenan en servidores con acceso restringido. Las contraseñas se guardan cifradas. Las transacciones de pago se procesan directamente por Wompi — Tapin nunca almacena números de tarjeta completos.</p>

          <h2>5. ¿Cuáles son tus derechos?</h2>
          <p>Como titular de tus datos, tienes derecho a conocer, actualizar, rectificar y solicitar la eliminación de tus datos personales, así como a revocar la autorización otorgada para su tratamiento. Para ejercer estos derechos, escríbenos al correo de soporte indicado en la página de contacto.</p>

          <h2>6. Retención de datos</h2>
          <p>Conservamos tus datos mientras exista una relación activa con Tapin (mientras tu tarjeta esté activa o tu cuenta exista). Puedes solicitar la eliminación de tus datos en cualquier momento.</p>

          <h2>7. Cambios a esta política</h2>
          <p>Podemos actualizar esta política ocasionalmente. Los cambios importantes se notificarán a través de nuestros canales habituales.</p>

          <p style="margin-top:32px;"><a href="/terminos">Ver Términos y Condiciones →</a></p>
        </div>
      </body>
    </html>
  `);
});

app.get("/terminos", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Términos y Condiciones — Tapin</title>
        <style>
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.crema};
               color:${MARCA.texto};margin:0;line-height:1.65;}
          .topbar{background:${MARCA.verdeOscuro};padding:18px 32px;}
          .contenido{max-width:720px;margin:0 auto;padding:48px 24px 80px;}
          h1{font-size:1.6rem;color:${MARCA.verdeOscuro};}
          h2{font-size:1.05rem;color:${MARCA.verdeOscuro};margin-top:32px;}
          p,li{font-size:0.92rem;color:${MARCA.texto};}
          .fecha{color:${MARCA.textoSuave};font-size:0.85rem;margin-bottom:32px;}
          a{color:${MARCA.verde};}
        </style>
      </head>
      <body>
        <div class="topbar">${logoSvg("#FFFFFF", 28)}</div>
        <div class="contenido">
          <h1>Términos y Condiciones</h1>
          <div class="fecha">Última actualización: ${new Date().toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" })}</div>

          <h2>1. Qué es Tapin</h2>
          <p>Tapin es un servicio de tarjetas con tecnología NFC que permite a los clientes de un negocio calificar su experiencia con un toque, dirigiendo las calificaciones positivas a Google y gestionando las negativas de forma privada.</p>

          <h2>2. Planes y pagos</h2>
          <p>El Plan Básico se cobra como pago único e incluye la tarjeta física, envío, y funciones esenciales. El Plan Pro mensual se cobra automáticamente cada mes a la tarjeta que el negocio registre, hasta que decida cancelar. Los pagos se procesan a través de Wompi. Los precios vigentes están publicados en <a href="/conoce">/conoce</a> y pueden cambiar con previo aviso.</p>

          <h2>3. Responsabilidad sobre las reseñas</h2>
          <p>Tapin facilita la redirección de clientes a la plataforma de reseñas de Google, pero no controla, edita, ni garantiza el contenido de las reseñas publicadas por terceros en Google. Tapin tampoco publica reseñas en nombre de los clientes ni de los negocios.</p>

          <h2>4. Uso aceptable</h2>
          <p>El negocio se compromete a usar Tapin de buena fe, sin incentivar reseñas falsas, sin manipular calificaciones, y sin usar el servicio para fines distintos a la gestión legítima de la reputación de su negocio.</p>

          <h2>5. Cancelación</h2>
          <p>El Plan Pro puede cancelarse en cualquier momento; la suscripción permanece activa hasta el final del período ya pagado. El Plan Básico no es reembolsable una vez enviada la tarjeta física, salvo defectos de fabricación.</p>

          <h2>6. Disponibilidad del servicio</h2>
          <p>Hacemos nuestro mejor esfuerzo por mantener el servicio disponible de forma continua, pero no garantizamos disponibilidad ininterrumpida. No somos responsables por pérdidas derivadas de interrupciones del servicio fuera de nuestro control razonable.</p>

          <h2>7. Modificaciones</h2>
          <p>Podemos actualizar estos términos ocasionalmente. El uso continuado del servicio después de un cambio implica la aceptación de los nuevos términos.</p>

          <p style="margin-top:32px;"><a href="/privacidad">Ver Política de Privacidad →</a></p>
        </div>
      </body>
    </html>
  `);
});

// ---------- Monitoreo básico de errores ----------
// Antes, un error en cualquier ruta simplemente aparecía en la consola de
// Render y se perdía ahí — nadie se enteraba hasta que un negocio se quejara.
// Esto captura cualquier error no manejado y (a) lo deja bien registrado en
// consola con fecha y ruta, y (b) le manda un correo al admin — pero como
// máximo uno cada 30 minutos, para no llenarte el correo si algo falla muchas
// veces seguidas.
let ultimaAlertaError = 0;
function avisarErrorCritico(origen, err) {
  console.error(`[ERROR ${new Date().toISOString()}] ${origen}:`, err && err.stack ? err.stack : err);
  const ahora = Date.now();
  if (ahora - ultimaAlertaError < 30 * 60 * 1000) return; // ya se avisó hace poco
  if (!process.env.EMAIL_USER && !process.env.SENDGRID_API_KEY) return;
  ultimaAlertaError = ahora;
  const destino = process.env.ADMIN_EMAIL || process.env.EMAIL_USER;
  if (!destino) return;
  enviarEmail(
    destino,
    "⚠️ Error en el servidor de Tapin",
    `<p>Ocurrió un error en <b>${escaparHtml(origen)}</b>.</p>
     <pre style="background:#f4f4f4;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:0.82rem;">${escaparHtml(String(err && err.stack ? err.stack : err)).slice(0, 2000)}</pre>
     <p style="font-size:0.8rem;color:#888;">No se te va a avisar de nuevo por 30 minutos, aunque el error se repita, para no saturarte el correo.</p>`
  ).catch(() => {});
}

// Captura errores que ninguna ruta atrapó (por ejemplo, algo que truena dentro
// de un `.then()` sin `.catch()`) — sin esto, el servidor entero se podía
// caer en silencio por un error suelto en cualquier parte del código.
process.on("uncaughtException", (err) => avisarErrorCritico("uncaughtException", err));
process.on("unhandledRejection", (err) => avisarErrorCritico("unhandledRejection", err));

// Debe ir DESPUÉS de todas las rutas — Express solo la usa cuando algo
// lanza un error dentro de una ruta y nadie lo atrapó explícitamente.
app.use((err, req, res, next) => {
  avisarErrorCritico(`${req.method} ${req.path}`, err);
  if (res.headersSent) return next(err);
  res.status(500).send("Ocurrió un error inesperado. Ya quedó registrado para revisarlo.");
});

app.listen(PORT, () => {
  console.log(`Tapin backend corriendo en el puerto ${PORT}`);
  if (!process.env.ADMIN_KEY) {
    console.warn(
      "\n⚠️  ADVERTENCIA DE SEGURIDAD: no configuraste ADMIN_KEY en las variables de " +
      "entorno de Render. El panel de administrador está usando la clave por defecto " +
      "'cambia-esta-clave', que cualquiera puede ver en el código público. Ve a Render " +
      "→ Environment → agrega ADMIN_KEY con una clave larga y difícil de adivinar.\n"
    );
  }
});
