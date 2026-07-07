// server.js
// Backend de Tapin: cuenta y registra cada toque NFC/QR con fecha y hora exactas,
// redirige al cliente a Google, y permite exportar el historial por negocio
// (útil para cobrar la suscripción a tus clientes con datos reales).

const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // necesario para recibir el webhook de Wompi (manda JSON)
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
  const transportador = obtenerTransportador();
  if (!transportador || !destinatario) {
    console.log(`[email no enviado — falta config o destinatario] asunto: ${asunto}`);
    return { ok: false, motivo: "Falta EMAIL_USER/EMAIL_PASS en el servidor o el negocio no tiene 'email' configurado." };
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
// Path vectorial real del logo (extraído del archivo de marca), reutilizado en todo el panel.
const LOGO_PATH = "M524 -695V-602H339V0H225V-602H39V-695Z M861 -560Q926 -560 974.5 -534.5Q1023 -509 1052 -471V-551H1167V0H1052V-82Q1023 -43 973.0 -17.0Q923 9 859 9Q788 9 729.0 -27.5Q670 -64 635.5 -129.5Q601 -195 601 -278Q601 -361 635.5 -425.0Q670 -489 729.5 -524.5Q789 -560 861 -560ZM885 -461Q841 -461 803.0 -439.5Q765 -418 741.5 -376.5Q718 -335 718 -278Q718 -221 741.5 -178.0Q765 -135 803.5 -112.5Q842 -90 885 -90Q929 -90 967.0 -112.0Q1005 -134 1028.5 -176.5Q1052 -219 1052 -276Q1052 -333 1028.5 -375.0Q1005 -417 967.0 -439.0Q929 -461 885 -461Z M1623 -560Q1695 -560 1754.5 -524.5Q1814 -489 1848.0 -425.0Q1882 -361 1882 -278Q1882 -195 1848.0 -129.5Q1814 -64 1754.5 -27.5Q1695 9 1623 9Q1560 9 1511.0 -16.5Q1462 -42 1431 -80V262H1317V-551H1431V-470Q1460 -508 1510.0 -534.0Q1560 -560 1623 -560ZM1598 -461Q1555 -461 1516.5 -439.0Q1478 -417 1454.5 -375.0Q1431 -333 1431 -276Q1431 -219 1454.5 -176.5Q1478 -134 1516.5 -112.0Q1555 -90 1598 -90Q1642 -90 1680.5 -112.5Q1719 -135 1742.5 -178.0Q1766 -221 1766 -278Q1766 -335 1742.5 -376.5Q1719 -418 1680.5 -439.5Q1642 -461 1598 -461Z M1980 -697Q1980 -728 2001.0 -749.0Q2022 -770 2053 -770Q2083 -770 2104.0 -749.0Q2125 -728 2125 -697Q2125 -666 2104.0 -645.0Q2083 -624 2053 -624Q2022 -624 2001.0 -645.0Q1980 -666 1980 -697ZM2109 -551V0H1995V-551Z M2763 -325V0H2650V-308Q2650 -382 2613.0 -421.5Q2576 -461 2512 -461Q2448 -461 2410.5 -421.5Q2373 -382 2373 -308V0H2259V-551H2373V-488Q2401 -522 2444.5 -541.0Q2488 -560 2537 -560Q2602 -560 2653.5 -533.0Q2705 -506 2734.0 -453.0Q2763 -400 2763 -325Z";

// Logo real de Tapin (el diseño original, no un trazo aproximado). Se guarda
// en dos versiones -verde (fondos claros) y blanca (fondos oscuros)- ambas
// incrustadas en base64 para no depender de un archivo estático aparte.
const LOGO_VERDE_B64 = "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";
const LOGO_BLANCO_B64 = "iVBORw0KGgoAAAANSUhEUgAAANcAAAB4CAYAAABhN2eOAAADDklEQVR4nO3c3ZaaMACF0djV939letO50FEgkEMS3Puuqx0Tbb7hR+CxLEsB2vvTewJwV+KCEHFBiLggRFwQIi4IEReEiAtCxAUh4oIQcUGIuCBEXBAiLggRF4SIC0LEBSHighBxQYi4IERcECIuCBEXhIgLQsQFIeKCEHFBiLggRFwQIi4IEReEiAtCxAUh4oIQcUGIuCBEXBAiLggRF4SIC0LEBSHighBxQYi4IORv7wmELR3HfnQc+0qvn/G3vO9Ntlyc8e6XV89faEMRF4SIC0LEBSF3j6vXwbWDem5/trCU+oX+7oBcLO/9fC7Ly58p999y1fp0pssZsHWPIqxfxAUh37BbWONRrtlK9fzidYYvfWeY4yZxXWMr2PRiWhv/zNifXvfda2yNs2eOU0UmrrwjW8JWi6nn2FvzWEr9nsJUkTnmyjq7i3nm53uOnR5jihNM4spYSrsFUPs6Pce+0shzK6WIaxZ7F1JiwY28iEeem2OugD3/4XsO+N/9/dqxxtFxW4zdypHPZVjiamttIWwtzterHVrqOfYea/PbmttV4VezW9jOmbD2/tsjV5Ckxz5r7/yGDGiNuMbUcyFNt4hHJa5nPXbJatXMcfRQauc3+vt5Iq5xjbj1mvbkQg/iml/NJUhcSFxtWOD8Iq4su1FfTFxtfNpC2XJ9MXFl2XJ9MXHdV88r6iniusKdbqsYdTd3xM9KXA2lby686nWGXKgzEtc1jtxtO9rYo261hiWutrYufK19lkYrW2O3vMGS/9xy0t7WcyF6LuKjY9tqHWDLlXGnxXin93IpcbFGWCeIK+fsI57PLuzeP//1xPUssaCOvGareRwJfMbnvg8538eyOEnUQcsn7NZekX+LR0XPwNnCPka8EZLG7BZCiLggRFwQIi4IEReEiAtCxAUh4oIQXyLPz5fCg7LlghBxQYi4IERcECIuCBEXhIgLQsQFIeKCEHFBiLggRFwQIi4IEReEiAtCxAUh4oIQcUGIuCBEXBAiLggRF4SIC0LEBSHighBxQYi4IERcEPIPhwFj8ZjGcZ8AAAAASUVORK5CYII=";

function logoSvg(color, height) {
  const esClaro = /^#?(fff|ffffff|FFFFFF|FFF)$/.test(String(color).replace("#", ""));
  const data = esClaro ? LOGO_BLANCO_B64 : LOGO_VERDE_B64;
  // Proporción real del logo (215x120) para no deformarlo al escalar por altura.
  const ancho = Math.round(height * (215 / 120));
  return `<img src="data:image/png;base64,${data}" alt="Tapin" style="height:${height}px;width:${ancho}px;display:block;object-fit:contain;" />`;
}

// Paleta de marca (extraída del logo oficial de Tapin)
const MARCA = {
  verdeOscuro: "#0B3D2C",
  verde: "#0F5132",
  verdeClaro: "#E7F0EA",
  crema: "#FAFAF8",
  texto: "#16201C",
  textoSuave: "#6B7570",
  borde: "#E7E5E0",
  rojo: "#C0392B",
  oro: "#C9A24B",
};

// Estilos base compartidos por todas las páginas del panel — look "pro" consistente.
// Íconos de "mostrar/ocultar contraseña", reutilizados en los formularios de
// login/registro de cliente y en el acceso de administrador.
const ICONO_OJO_ABIERTO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 12C1 12 5 4 12 4C19 4 23 12 23 12C23 12 19 20 12 20C5 20 1 12 1 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.8"/></svg>`;
const ICONO_OJO_CERRADO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3L21 21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10.6 5.2C11.05 5.1 11.51 5 12 5C19 5 23 12 23 12C23 12 21.8 14.2 19.6 16.1M6.9 6.9C3.7 8.9 1 12 1 12C1 12 5 19 12 19C13.6 19 15 18.6 16.2 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.9 9.9C9.34 10.46 9 11.19 9 12C9 13.66 10.34 15 12 15C12.81 15 13.54 14.66 14.1 14.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

const ESTILO_BASE = `
  *{box-sizing:border-box;}
  body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.crema};color:${MARCA.texto};margin:0;}
  a{color:${MARCA.verde};}
  .topbar{background:${MARCA.verdeOscuro};padding:18px 32px;display:flex;align-items:center;justify-content:space-between;}
  .topbar .back{color:#CFE3D8;font-size:0.82rem;font-weight:500;text-decoration:none;}
  .topbar .back:hover{color:#fff;}
  .content{padding:32px 32px 60px;max-width:1140px;margin:0 auto;}
  .eyebrow{font-size:0.72rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MARCA.verde};margin-bottom:6px;}
  .titulo-pagina{font-size:1.5rem;font-weight:700;margin:0 0 4px;letter-spacing:-0.01em;}
  .subtitulo{color:${MARCA.textoSuave};font-size:0.92rem;margin-bottom:30px;}
`;

// ---------- Configuración de negocios ----------
// Agrega aquí un negocio por cada Tapin que tengas en la calle.
// "slug" es lo que va en la URL del QR/NFC, ej: /r/mi-negocio
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
// a qué negocio va a parar. Programas el QR/NFC con ese código, y cuando consigas
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
// Necesitas dos variables de entorno en Render, sacadas de tu dashboard de
// comercio en Wompi (comercios.wompi.co → Desarrolladores):
//   WOMPI_PUBLIC_KEY      → empieza con "pub_test_" (pruebas) o "pub_prod_" (real)
//   WOMPI_INTEGRITY_SECRET → tu "Secreto de integridad" (NUNCA la Llave Privada,
//                             son cosas distintas). Se usa solo en el servidor,
//                             nunca se envía al navegador.
const PEDIDOS_FILE = path.join(DATA_DIR, "pedidos.json");
function leerPedidos() {
  if (!fs.existsSync(PEDIDOS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PEDIDOS_FILE, "utf8")); } catch { return {}; }
}
function guardarPedidos(pedidos) {
  fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2));
}

// Genera la firma de integridad que exige Wompi: SHA256 de
// referencia + monto_en_centavos + moneda + secreto_de_integridad (en ese orden,
// todo concatenado sin separadores). Esto se hace en el servidor por seguridad.
function firmaIntegridadWompi(referencia, montoCentavos, moneda) {
  const cadena = `${referencia}${montoCentavos}${moneda}${process.env.WOMPI_INTEGRITY_SECRET}`;
  return crypto.createHash("sha256").update(cadena).digest("hex");
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

function iniciarSesionCliente(res, clienteId) {
  const sesiones = leerSesionesClientes();
  const token = generarToken() + generarToken(); // más largo que los magic links, es persistente
  sesiones[token] = clienteId;
  guardarSesionesClientes(sesiones);
  const TREINTA_DIAS = 30 * 24 * 60 * 60;
  res.setHeader("Set-Cookie", `tapin_sesion=${token}; HttpOnly; Path=/; Max-Age=${TREINTA_DIAS}; SameSite=Lax`);
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
function obtenerNegocio(slug) {
  const codigos = leerCodigos();
  const entrada = codigos[slug];
  if (entrada && entrada.desactivado) return null; // tarjeta quitada explícitamente
  if (entrada && entrada.activado && entrada.negocio) return entrada.negocio;
  if (NEGOCIOS[slug]) return NEGOCIOS[slug];
  return null;
}

// Funciones exclusivas de Plan Pro: retroalimentación privada + alerta instantánea
// ante retroalimentación negativa, registro detallado toque por toque, reporte
// mensual (correo + PDF con picos/caídas por hora), exportación de reportes
// (CSV/PDF/Word), generador de contenido para redes, y comparación sectorial.
// El plan básico (pago único) solo incluye: tarjeta física + envío, redirección
// automática a Google, panel con historial y estadísticas resumidas, y acta de entrega.
// Si el negocio no tiene plan "pro", estas simplemente no se disparan — sin
// importar si el código las soporta técnicamente.
function esPro(negocio) {
  return !!negocio && negocio.plan === "pro";
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
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;">
          <div style="font-size:0.65rem;color:#888;">${v}</div>
          <div style="width:100%;max-width:22px;height:${alturaPx}px;background:#0F5132;border-radius:4px 4px 0 0;"></div>
          <div style="font-size:0.62rem;color:#999;text-transform:capitalize;">${nombresDias[i]}</div>
        </div>`;
    })
    .join("");
}

function registrarToque(slug, req, negocio) {
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

function guardarTestimonio(slug, frase, valor, negocio) {
  const datos = leerDatos();
  if (!datos[slug]) datos[slug] = { total: 0, eventos: [] };
  if (!datos[slug].testimonios) datos[slug].testimonios = [];
  const ahora = new Date();
  datos[slug].testimonios.push({
    fechaISO: ahora.toISOString(),
    fechaLegible: ahora.toLocaleString("es-CO", { timeZone: zonaDe(negocio) }),
    frase,
    valor,
  });
  guardarDatos(datos);
}

function guardarQueja(slug, comentario, negocio, telefono = "") {
  const datos = leerDatos();
  if (!datos[slug]) datos[slug] = { total: 0, eventos: [] };
  if (!datos[slug].quejas) datos[slug].quejas = [];
  const ahora = new Date();
  datos[slug].quejas.push({
    fechaISO: ahora.toISOString(),
    fechaLegible: ahora.toLocaleString("es-CO", { timeZone: zonaDe(negocio) }),
    comentario,
    telefono,
    estado: "pendiente", // pendiente | contactado | resuelto
  });
  guardarDatos(datos);
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
      dinamicos[codigo] = codigos[codigo].negocio;
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
  if (pares.length === 0) return null;
  const total = pares.reduce((acc, [slug]) => {
    const eventos = (datos[slug] && datos[slug].eventos) || [];
    return acc + calcularResumen(eventos).semana;
  }, 0);
  return Math.round(total / pares.length);
}

// ---------- Rutas ----------

// Esta es la URL que va en el QR o se programa en el chip NFC de la tarjeta Tapin.
// En vez de redirigir directo a Google, primero muestra una pantalla rápida
// de "¿cómo te fue?" — si la respuesta es positiva, lo manda a Google;
// si es negativa, lo manda a un formulario privado en vez de exponerlo en público.
// Ejemplo: https://tu-dominio.com/r/mi-negocio
app.get("/r/:slug", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);

  if (!negocio) {
    const codigos = leerCodigos();
    if (codigos[slug] && !codigos[slug].activado) {
      return res.redirect(302, `/activar/${slug}`);
    }
    return res.status(404).send("Negocio no encontrado. Revisa el enlace del QR/NFC.");
  }

  registrarToque(slug, req, negocio);

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
          .caras{display:flex;justify-content:space-between;gap:8px;}
          .caras a{flex:1;text-decoration:none;font-size:2.2rem;padding:14px 0;border-radius:14px;
                    background:#F8F4EC;transition:transform .15s;}
          .caras a:active{transform:scale(0.93);}
        </style>
      </head>
      <body>
        <div class="box">
          <h1>${negocio.nombre}</h1>
          <p>¿Cómo te fue con nosotros hoy?</p>
          <div class="caras">
            <a href="/calificar/${slug}?valor=1">😞</a>
            <a href="/calificar/${slug}?valor=2">😐</a>
            <a href="/calificar/${slug}?valor=3">🙂</a>
            <a href="/calificar/${slug}?valor=4">😄</a>
            <a href="/calificar/${slug}?valor=5">🤩</a>
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
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  const valor = parseInt(req.query.valor, 10);

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
        });
        guardarClientes(clientes);
      }
    }
  }

  if (valor >= 4) {
    // El generador de contenido (frases con un toque) es exclusivo del Plan Pro.
    // Los negocios básicos van directo a Google, sin este paso extra.
    if (!esPro(negocio)) {
      return res.redirect(302, negocio.googleUrl);
    }

    const frases = [
      "Excelente atención",
      "Muy buena comida",
      "Ambiente increíble",
      "Rápido y eficiente",
      "Lo recomiendo 100%",
      "Volveré seguro",
    ];
    const chips = frases
      .map(
        (f) =>
          `<a href="/testimonio/${slug}?valor=${valor}&frase=${encodeURIComponent(f)}" class="chip">${f}</a>`
      )
      .join("");

    return res.send(`
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${negocio.nombre}</title>
          <style>
            *{box-sizing:border-box;}
            body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#F8F4EC;
                 display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
            .box{background:#fff;border-radius:18px;padding:32px 26px;max-width:380px;width:100%;
                 text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.08);}
            h1{font-size:1.15rem;margin:0 0 6px;color:#16201C;}
            p{color:#777;font-size:0.88rem;margin:0 0 20px;}
            .chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:18px;}
            .chip{background:#F1F7F4;color:#0F5132;border:1px solid #DCEAE2;border-radius:100px;
                  padding:10px 14px;font-size:0.85rem;font-weight:600;text-decoration:none;}
            .chip:active{transform:scale(0.96);}
            .saltar{display:block;color:#999;font-size:0.82rem;text-decoration:underline;}
          </style>
        </head>
        <body>
          <div class="box">
            <h1>¡Qué bueno! 🎉</h1>
            <p>¿Qué fue lo que más te gustó? (toca una, opcional)</p>
            <div class="chips">${chips}</div>
            <a class="saltar" href="${negocio.googleUrl}">Saltar e ir directo a Google &rarr;</a>
          </div>
        </body>
      </html>
    `);
  }

  // Calificación negativa: mostramos un formulario privado en vez de mandarlo a Google
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
          textarea{width:100%;border:1px solid #ddd;border-radius:10px;padding:12px;font-size:0.95rem;
                    min-height:100px;font-family:inherit;}
          button{margin-top:14px;width:100%;background:#1F6E4E;color:#fff;border:none;border-radius:10px;
                 padding:13px;font-size:0.95rem;font-weight:600;cursor:pointer;}
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Lamentamos que tu visita no haya sido perfecta</h1>
          <p>Cuéntanos qué pasó — esto llega directo al negocio, no se publica en ningún lado.</p>
          <form method="POST" action="/calificar/${slug}">
            <textarea name="comentario" placeholder="Escribe aquí lo que pasó..."></textarea>
            <input type="tel" name="telefono" placeholder="Tu teléfono (opcional, para que te llamen)" style="width:100%;margin-top:10px;padding:12px;border:1px solid #ddd;border-radius:10px;font-size:0.92rem;font-family:inherit;">
            <button type="submit">Enviar</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

app.post("/calificar/:slug", async (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  const comentario = req.body.comentario || "(sin comentario)";
  const telefono = req.body.telefono || "";
  guardarQueja(slug, comentario, negocio, telefono);

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
            <p style="margin:0;color:#16201C;">"${comentario}"</p>
          </div>
          ${telefono ? `<p><b>Teléfono para contactarlo:</b> <a href="tel:${telefono}">${telefono}</a></p>` : `<p style="color:#888;">No dejó teléfono de contacto.</p>`}
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
    </style></head>
    <body><div class="box"><h2>Gracias por avisarnos 🙏</h2><p>El negocio ya recibió tu comentario y lo va a revisar.</p></div></body></html>
  `);
});

// Guarda el micro-testimonio elegido con un solo toque y manda al cliente a Google.
// Esto alimenta el generador de contenido para redes (/contenido/:slug).
app.get("/testimonio/:slug", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  const frase = req.query.frase || "";
  const valor = parseInt(req.query.valor, 10) || 5;
  if (frase && esPro(negocio)) guardarTestimonio(slug, frase, valor, negocio);

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
app.get("/editar", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const key = req.query.key;
  const todos = todosLosNegocios();

  const filas = Object.entries(todos)
    .map(([slug, n]) => {
      return `<tr>
        <td><b>${n.nombre}</b></td>
        <td><code class="codigo">/r/${slug}</code></td>
        <td>${n.categoria || "—"}</td>
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
          <div>${logoSvg("#FFFFFF", 22)}</div>
          <a class="back" href="/stats?key=${key}">&larr; Volver al panel</a>
        </div>
        <div class="content">
          <div class="eyebrow">Administración</div>
          <h1 class="titulo-pagina">Negocios</h1>
          <div class="subtitulo">Crea o edita negocios directamente, sin tocar código.</div>

          <a class="btn-nuevo" href="/editar/nuevo?key=${key}">+ Agregar negocio nuevo</a>

          <table>
            <tr><th>Nombre</th><th>Enlace de toque</th><th>Categoría</th><th></th></tr>
            ${filas || "<tr><td colspan='4'>Todavía no hay negocios.</td></tr>"}
          </table>
        </div>
      </body>
    </html>
  `);
});

// Formulario para crear un negocio nuevo directamente (sin pasar por código de activación).
app.get("/editar/nuevo", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const key = req.query.key;
  res.send(formularioNegocio({ titulo: "Agregar negocio nuevo", accion: `/editar/nuevo?key=${key}`, key }));
});

app.post("/editar/nuevo", (req, res) => {
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

  codigos[slug] = {
    activado: true,
    creado: new Date().toISOString(),
    activadoEl: new Date().toISOString(),
    negocio: {
      nombre,
      googleUrl,
      categoria: categoria || "otro",
      pais: pais || "colombia",
      claveAcceso: `${slug.toLowerCase()}-panel`,
      email: email || "",
      plan: plan === "pro" ? "pro" : "basico",
      direccion: direccion || "",
      lat: lat ? parseFloat(lat) : null,
      lng: lng ? parseFloat(lng) : null,
    },
  };
  guardarCodigos(codigos);

  res.redirect(`/editar?key=${req.query.key}`);
});

// Editar un negocio dinámico existente (creado por código de activación o desde /editar/nuevo).
app.get("/editar/:slug", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) {
    return res.status(404).send("Negocio no encontrado.");
  }
  const key = req.query.key;
  res.send(formularioNegocio({
    titulo: `Editar — ${negocio.nombre}`,
    accion: `/editar/${slug}?key=${key}`,
    key,
    valores: negocio,
    slug,
  }));
});

app.post("/editar/:slug", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const { slug } = req.params;
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
  codigos[slug].negocio = {
    nombre,
    googleUrl,
    categoria: categoria || "otro",
    pais: pais || negocioActual.pais || "colombia",
    claveAcceso: (codigos[slug].negocio && codigos[slug].negocio.claveAcceso) || negocioActual.claveAcceso || `${slug.toLowerCase()}-panel`,
    email: email || negocioActual.email || "",
    plan: plan === "pro" ? "pro" : "basico",
    direccion: direccion || "",
    lat: lat ? parseFloat(lat) : null,
    lng: lng ? parseFloat(lng) : null,
  };
  guardarCodigos(codigos);

  res.redirect(`/editar?key=${req.query.key}`);
});

// Pantalla de confirmación antes de quitar una tarjeta (para evitar borrados accidentales).
app.get("/editar/:slug/quitar", (req, res) => {
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
        <div class="topbar"><div>${logoSvg("#FFFFFF", 22)}</div></div>
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
app.post("/editar/:slug/quitar", (req, res) => {
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

  res.redirect(`/editar?key=${req.query.key}`);
});

// Plantilla reutilizable del formulario de crear/editar negocio.
function formularioNegocio({ titulo, accion, key, valores = {}, slug = null }) {
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
          <div>${logoSvg("#FFFFFF", 22)}</div>
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
                <option value="pro" ${valores.plan === "pro" ? "selected" : ""}>Pro ($59.900/mes — alertas, reporte mensual, contenido)</option>
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
        </div>
      </body>
    </html>
  `;
}


// Panel de generación y administración de códigos de activación.
// Genera un código por cada tarjeta física ANTES de saber a qué negocio va.
// Visítalo así: https://tu-dominio.com/codigos?key=TU_CLAVE
app.get("/codigos", (req, res) => {
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
      return `<tr>
        <td><code class="codigo">${codigo}</code></td>
        <td>${estado}</td>
        <td class="url-cell">${urlTarjeta}</td>
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
          <div>${logoSvg("#FFFFFF", 22)}</div>
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
            </form>
          </div>

          <table>
            <tr><th>Código</th><th>Estado</th><th>URL para la tarjeta (NFC/QR)</th><th></th></tr>
            ${filas || "<tr><td colspan='4'>Todavía no has generado ningún código.</td></tr>"}
          </table>
        </div>
      </body>
    </html>
  `);
});

// Genera N códigos nuevos y los guarda.
app.post("/codigos/generar", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const cantidad = Math.min(200, Math.max(1, parseInt(req.body.cantidad, 10) || 1));
  const codigos = leerCodigos();

  for (let i = 0; i < cantidad; i++) {
    let nuevo;
    do {
      nuevo = generarCodigo();
    } while (codigos[nuevo]); // evita colisiones, aunque son muy improbables
    codigos[nuevo] = { activado: false, creado: new Date().toISOString() };
  }

  guardarCodigos(codigos);
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
    return res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h2>Esta tarjeta ya está activada</h2>
        <p>Pertenece a: <b>${entrada.negocio.nombre}</b></p>
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
        </style>
      </head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 22)}</div></div>
        <div class="content">
          <div class="eyebrow">Código ${codigo}</div>
          <h1 class="titulo-pagina">Configura tu tarjeta Tapin</h1>
          <div class="subtitulo">Completa los datos del negocio para dejar la tarjeta lista para usar.</div>

          <div class="form-card">
            <form method="POST" action="/activar/${codigo}" id="form-activar">
              <label>Nombre del negocio</label>
              <input type="text" name="nombre" required placeholder="Ej: Restaurante La 21">

              <label>Enlace de reseñas de Google</label>
              <input type="url" name="googleUrl" required placeholder="https://g.page/r/.../review">

              <label>Email del negocio (alertas y reportes llegan aquí)</label>
              <input type="email" name="email" required placeholder="dueno@negocio.com">

              <label>Dirección del negocio</label>
              <div class="direccion-wrap">
                <input type="text" id="input-direccion" name="direccion" autocomplete="off"
                       placeholder="Escribe al menos 3 letras — ej: Cra 7 Chía">
                <div class="sugerencias" id="lista-sugerencias"></div>
              </div>
              <div class="direccion-estado" id="direccion-estado"></div>
              <input type="hidden" name="lat" id="input-lat">
              <input type="hidden" name="lng" id="input-lng">
              <input type="hidden" name="ciudad" id="input-ciudad">

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
              <select name="plan">
                <option value="basico">Básico ($119.900 — envío incluido)</option>
                <option value="pro">Pro ($59.900/mes — alertas, reporte mensual, contenido)</option>
              </select>

              <label>País (define la hora local de los reportes)</label>
              <select name="pais" id="input-pais">
                <option value="colombia" data-codigo="co">Colombia</option>
                <option value="panama" data-codigo="pa">Panamá</option>
                <option value="paraguay" data-codigo="py">Paraguay</option>
                <option value="miami" data-codigo="us">Estados Unidos (Miami)</option>
              </select>

              <button type="submit">Activar tarjeta</button>
            </form>
          </div>
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

          // ---------- Buscador de direcciones con autocompletado (OpenStreetMap Nominatim, gratis) ----------
          const inputDireccion = document.getElementById('input-direccion');
          const listaSugerencias = document.getElementById('lista-sugerencias');
          const estadoDireccion = document.getElementById('direccion-estado');
          const inputPais = document.getElementById('input-pais');
          let temporizador = null;
          let ultimaConsulta = '';

          function paisCodigo() {
            const opcion = inputPais.options[inputPais.selectedIndex];
            return opcion ? opcion.dataset.codigo : 'co';
          }

          async function buscarDirecciones(texto) {
            try {
              const url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6' +
                          '&countrycodes=' + paisCodigo() + '&q=' + encodeURIComponent(texto);
              const resp = await fetch(url, { headers: { 'Accept-Language': 'es' } });
              const resultados = await resp.json();
              mostrarSugerencias(resultados);
            } catch (err) {
              estadoDireccion.textContent = 'No se pudo buscar en este momento. Puedes escribir la dirección manualmente.';
            }
          }

          function mostrarSugerencias(resultados) {
            listaSugerencias.innerHTML = '';
            if (!resultados || resultados.length === 0) {
              listaSugerencias.classList.remove('activo');
              return;
            }
            resultados.forEach((r) => {
              const item = document.createElement('div');
              item.className = 'sugerencia-item';
              item.textContent = r.display_name;
              item.addEventListener('click', () => seleccionarDireccion(r));
              listaSugerencias.appendChild(item);
            });
            listaSugerencias.classList.add('activo');
          }

          function seleccionarDireccion(r) {
            inputDireccion.value = r.display_name;
            document.getElementById('input-lat').value = r.lat;
            document.getElementById('input-lng').value = r.lon;
            const dir = r.address || {};
            const ciudad = dir.city || dir.town || dir.village || dir.municipality || '';
            document.getElementById('input-ciudad').value = ciudad;
            listaSugerencias.classList.remove('activo');
            estadoDireccion.innerHTML = '<span class="direccion-ok">✓ Ubicación encontrada — aparecerá en el mapa público de Tapin.</span>';
          }

          inputDireccion.addEventListener('input', () => {
            const texto = inputDireccion.value.trim();
            clearTimeout(temporizador);
            estadoDireccion.textContent = '';
            document.getElementById('input-lat').value = '';
            document.getElementById('input-lng').value = '';
            if (texto.length < 3) {
              listaSugerencias.classList.remove('activo');
              return;
            }
            // Pequeña espera antes de buscar, para no mandar una consulta por cada tecla.
            temporizador = setTimeout(() => {
              if (texto !== ultimaConsulta) {
                ultimaConsulta = texto;
                buscarDirecciones(texto);
              }
            }, 400);
          });

          document.addEventListener('click', (e) => {
            if (!e.target.closest('.direccion-wrap')) {
              listaSugerencias.classList.remove('activo');
            }
          });
        </script>
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

  const { nombre, googleUrl, categoria, pais, email, plan, direccion, lat, lng, ciudad } = req.body;
  if (!nombre || !googleUrl) {
    return res.status(400).send("Faltan datos: nombre y enlace de Google son obligatorios.");
  }

  entrada.activado = true;
  entrada.activadoEl = new Date().toISOString();
  entrada.negocio = {
    nombre,
    googleUrl,
    categoria: categoria || "otro",
    pais: pais || "colombia",
    claveAcceso: `${codigo.toLowerCase()}-panel`,
    email: email || "",
    plan: plan === "pro" ? "pro" : "basico",
    direccion: direccion || "",
    lat: lat ? parseFloat(lat) : null,
    lng: lng ? parseFloat(lng) : null,
    ciudad: ciudad || "",
  };

  guardarCodigos(codigos);

  res.send(`
    <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${ESTILO_BASE}
        .ok-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:16px;padding:28px;max-width:460px;}
        .ok-card code{background:${MARCA.verdeClaro};padding:3px 8px;border-radius:6px;}
      </style></head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 22)}</div></div>
        <div class="content">
          <div class="eyebrow">Listo</div>
          <h1 class="titulo-pagina">¡Tarjeta activada!</h1>
          <div class="ok-card">
            <p><b>${nombre}</b> ya está conectado a esta tarjeta Tapin.</p>
            <p>Panel de este negocio:<br><code>${req.protocol}://${req.get("host")}/mi-panel/${codigo}?key=${entrada.negocio.claveAcceso}</code></p>
            <p>Esta tarjeta ya está lista — el cliente puede empezar a usarla de inmediato.</p>
          </div>
        </div>
      </body>
    </html>
  `);
});

app.get("/stats", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }

  const datos = leerDatos();
  const key = req.query.key;
  const NEGOCIOS_TOTAL = todosLosNegocios();

  // Totales agregados de TODAS las tarjetas juntas (sección de resumen general)
  let totalNegocios = 0;
  let totalToquesGlobal = 0;
  let totalHoyGlobal = 0;
  let totalSemanaGlobal = 0;
  const dias7Global = new Array(7).fill(0);
  for (const slug in NEGOCIOS_TOTAL) {
    const eventos = (datos[slug] && datos[slug].eventos) || [];
    const r = calcularResumen(eventos);
    totalNegocios++;
    totalToquesGlobal += r.total;
    totalHoyGlobal += r.hoy;
    totalSemanaGlobal += r.semana;
    r.dias7.forEach((v, i) => { dias7Global[i] += v; });
  }

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

  function tarjetaHtml(slug) {
    const eventos = (datos[slug] && datos[slug].eventos) || [];
    const r = calcularResumen(eventos);
    const ultimoTexto = r.ultimo ? r.ultimo.fechaLegible : "Sin toques todavía";
    const promSector = promedioSector(NEGOCIOS_TOTAL[slug].categoria, slug, datos);
    const sectorBadge = promSector !== null
      ? `<div class="sector-badge" style="color:${r.semana - promSector >= 0 ? MARCA.verde : MARCA.rojo}">
           ${r.semana - promSector >= 0 ? "▲" : "▼"} ${r.semana - promSector >= 0 ? "+" : ""}${r.semana - promSector} vs. promedio del sector
         </div>`
      : "";

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

        <div class="card-ultimo">Último toque: <b>${ultimoTexto}</b></div>

        <div class="card-actions">
          <a href="/historial/${slug}?key=${key}">Historial</a>
          <a href="/reporte/${slug}?key=${key}">Reporte</a>
          ${NEGOCIOS_TOTAL[slug].claveAcceso ? `<a href="/mi-panel/${slug}?key=${NEGOCIOS_TOTAL[slug].claveAcceso}" target="_blank">Panel del negocio</a>` : ""}
          <a href="/export/${slug}.csv?key=${key}">CSV</a>
          <a href="/export/${slug}.pdf?key=${key}">PDF</a>
          <a href="/export/${slug}.docx?key=${key}">Word</a>
          <a href="/entrega/${slug}.pdf?key=${key}">Acta de entrega</a>
          <a href="/quejas/${slug}?key=${key}">Retroalimentación</a>
          <a href="/contenido/${slug}?key=${key}">Contenido</a>
          <a href="/notificar/${slug}?key=${key}">Enviar reporte por email</a>
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
          .content{max-width:880px;}
          .seccion{margin-bottom:48px;}
          .seccion-header{text-align:center;margin-bottom:24px;}
          .seccion-header .eyebrow{justify-content:center;}
          .seccion-header h2{font-size:1.15rem;font-weight:700;margin:0 0 4px;}
          .seccion-header p{color:${MARCA.textoSuave};font-size:0.86rem;margin:0;}

          /* Resumen global */
          .resumen-grid{display:flex;gap:14px;flex-wrap:wrap;}
          .resumen-box{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;padding:22px 16px;text-align:center;
                       box-shadow:0 1px 2px rgba(11,61,44,0.04);flex:1;min-width:140px;}
          .resumen-num{font-size:2rem;font-weight:700;color:${MARCA.verdeOscuro};line-height:1;}
          .resumen-lbl{font-size:0.74rem;color:${MARCA.textoSuave};margin-top:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;}
          .chart-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;padding:22px 24px;margin-top:16px;
                      box-shadow:0 1px 2px rgba(11,61,44,0.04);}
          .chart-card-titulo{font-size:0.82rem;font-weight:600;color:${MARCA.textoSuave};margin-bottom:18px;text-align:center;}
          .sparkline-grande{height:120px;max-width:520px;margin:0 auto;}

          /* Lista de negocios */
          .lista-negocios{display:flex;flex-direction:column;gap:16px;}
          .card{background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 2px rgba(11,61,44,0.04), 0 8px 24px rgba(11,61,44,0.06);border:1px solid ${MARCA.borde};transition:box-shadow .2s;}
          .card:hover{box-shadow:0 1px 2px rgba(11,61,44,0.05), 0 12px 32px rgba(11,61,44,0.10);}
          .card-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;}
          .card-nombre{font-weight:700;font-size:1.08rem;letter-spacing:-0.01em;}
          .badge-pro{background:${MARCA.oro};color:#fff;font-size:0.62rem;font-weight:800;padding:2px 7px;border-radius:100px;letter-spacing:0.04em;vertical-align:middle;}
          .badge-basico{background:${MARCA.borde};color:${MARCA.textoSuave};font-size:0.62rem;font-weight:800;padding:2px 7px;border-radius:100px;letter-spacing:0.04em;vertical-align:middle;}
          .card-slug{font-size:0.76rem;color:${MARCA.textoSuave};margin-top:2px;font-family:monospace;}
          .card-total{text-align:right;font-size:1.7rem;font-weight:700;color:${MARCA.verde};line-height:1;}
          .card-total span{display:block;font-size:0.6rem;font-weight:600;color:${MARCA.textoSuave};margin-top:4px;letter-spacing:0.04em;text-transform:uppercase;}
          .card-metrics{display:flex;gap:12px;margin-bottom:18px;max-width:340px;}
          .metric{background:${MARCA.verdeClaro};border-radius:12px;padding:12px 14px;flex:1;text-align:center;}
          .metric-num{font-size:1.3rem;font-weight:700;color:${MARCA.verdeOscuro};}
          .metric-lbl{font-size:0.68rem;color:${MARCA.verde};margin-top:2px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;}
          .sparkline{display:flex;align-items:flex-end;gap:5px;height:64px;margin-bottom:10px;max-width:300px;}
          .sector-badge{font-size:0.74rem;font-weight:700;margin-bottom:14px;}
          .card-ultimo{font-size:0.82rem;color:${MARCA.textoSuave};margin-bottom:16px;padding-top:14px;border-top:1px solid ${MARCA.borde};}
          .card-ultimo b{color:${MARCA.texto};}
          .card-actions{display:flex;flex-wrap:wrap;}
          .card-actions a{color:${MARCA.verde};font-weight:600;text-decoration:none;font-size:0.78rem;white-space:nowrap;margin:0 14px 6px 0;}
          .card-actions a:hover{color:${MARCA.verdeOscuro};text-decoration:underline;}
          .seccion-pais{margin-bottom:36px;}
          .pais-header{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;
                       border-bottom:2px solid ${MARCA.verdeOscuro};padding-bottom:10px;margin-bottom:18px;}
          .pais-titulo{font-size:1.15rem;font-weight:800;color:${MARCA.verdeOscuro};}
          .pais-conteo{font-size:0.78rem;color:${MARCA.textoSuave};font-weight:600;}
          .botones-paises{display:flex;flex-wrap:wrap;justify-content:center;margin-bottom:28px;}
          .btn-pais{background:#fff;border:1px solid ${MARCA.borde};color:${MARCA.texto};font-weight:700;
                    font-size:0.82rem;padding:9px 18px;border-radius:100px;text-decoration:none;
                    margin:0 8px 8px 0;display:inline-block;}
          .btn-pais:hover{border-color:${MARCA.verdeOscuro};background:${MARCA.verdeClaro};}
        </style>
      </head>
      <body>
        <div class="topbar">
          <div style="display:flex;align-items:center;gap:0;">${logoSvg("#FFFFFF", 22)}</div>
          <div>
            <a href="/descubre" style="color:#CFE3D8;font-size:0.78rem;font-weight:600;text-decoration:none;margin-right:18px;" target="_blank">Mapa público</a>
            <a href="/editar?key=${key}" style="color:#CFE3D8;font-size:0.78rem;font-weight:600;text-decoration:none;margin-right:18px;">Editar negocios</a>
            <a href="/codigos?key=${key}" style="color:#CFE3D8;font-size:0.78rem;font-weight:600;text-decoration:none;">+ Generar tarjetas</a>
          </div>
        </div>
        <div class="content">

          <div class="seccion">
            <div class="seccion-header">
              <div class="eyebrow">Resumen general</div>
              <h2>Todas tus tarjetas Tapin</h2>
              <p>Suma de actividad de todos los negocios activos.</p>
            </div>
            <div class="resumen-grid">
              <div class="resumen-box"><div class="resumen-num">${totalNegocios}</div><div class="resumen-lbl">Tarjetas activas</div></div>
              <div class="resumen-box"><div class="resumen-num">${totalToquesGlobal}</div><div class="resumen-lbl">Toques totales</div></div>
              <div class="resumen-box"><div class="resumen-num">${totalHoyGlobal}</div><div class="resumen-lbl">Toques hoy</div></div>
              <div class="resumen-box"><div class="resumen-num">${totalSemanaGlobal}</div><div class="resumen-lbl">Últimos 7 días</div></div>
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
      </body>
    </html>
  `);
});

// Historial detallado de un negocio: fecha y hora exacta de cada toque.
// Esto es lo que le puedes mostrar o entregar a tu cliente para justificar la suscripción.
// Visítalo así: https://tu-dominio.com/historial/mi-negocio?key=TU_CLAVE
app.get("/historial/:slug", (req, res) => {
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
        <h1>Historial de toques — ${negocio.nombre}</h1>
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
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

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
        <td>${q.fechaLegible}</td>
        <td>${q.comentario}</td>
        <td>${q.telefono ? `<a href="tel:${q.telefono}">${q.telefono}</a>` : "—"}</td>
        <td><span style="background:${fondos[estado]};color:${colores[estado]};padding:4px 10px;border-radius:100px;font-size:0.74rem;font-weight:700;">${estado}</span></td>
        <td>
          ${estado !== "contactado" ? `<a href="/quejas/${slug}/estado?key=${req.query.key}&i=${i}&estado=contactado" style="margin-right:8px;">Marcar contactado</a>` : ""}
          ${estado !== "resuelto" ? `<a href="/quejas/${slug}/estado?key=${req.query.key}&i=${i}&estado=resuelto">Marcar resuelto</a>` : ""}
        </td>
      </tr>`;
    })
    .join("");

  res.send(`
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Retroalimentación — ${negocio.nombre}</title>
    <style>
      ${ESTILO_BASE}
      .metrics{display:flex;gap:14px;margin-bottom:24px;max-width:600px;}
      .metric{background:#fff;border:1px solid ${MARCA.borde};border-radius:10px;padding:14px;flex:1;text-align:center;}
      .metric-num{font-size:1.5rem;font-weight:700;color:${MARCA.verde};}
      .metric-lbl{font-size:0.72rem;color:${MARCA.textoSuave};margin-top:4px;}
      table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden;border:1px solid ${MARCA.borde};}
      th,td{padding:10px 16px;text-align:left;border-bottom:1px solid ${MARCA.borde};font-size:0.86rem;}
      th{background:${MARCA.verdeOscuro};color:#fff;font-size:0.72rem;text-transform:uppercase;}
      a{color:${MARCA.verde};font-weight:600;font-size:0.82rem;text-decoration:none;}
    </style></head>
    <body>
      <div class="topbar"><div>${logoSvg("#FFFFFF", 22)}</div><a class="back" href="/stats?key=${req.query.key}">&larr; Volver al panel</a></div>
      <div class="content">
        <div class="eyebrow">Rescate de clientes</div>
        <h1 class="titulo-pagina">Retroalimentación privada — ${negocio.nombre}</h1>
        <div class="subtitulo">Cada reseña negativa se queda aquí en vez de publicarse. El dueño recibe un correo al instante para poder reaccionar.</div>
        <div class="metrics">
          <div class="metric"><div class="metric-num">${quejas.length}</div><div class="metric-lbl">Total recibida</div></div>
          <div class="metric"><div class="metric-num">${resueltas}</div><div class="metric-lbl">Resueltas</div></div>
          <div class="metric"><div class="metric-num">${tasaRecuperacion}%</div><div class="metric-lbl">Tasa de recuperación</div></div>
        </div>
        <table><tr><th>Fecha</th><th>Comentario</th><th>Teléfono</th><th>Estado</th><th>Acción</th></tr>
        ${filas || "<tr><td colspan='5'>Sin retroalimentación registrada todavía.</td></tr>"}
        </table>
      </div>
    </body></html>
  `);
});

// Cambia el estado de una queja (pendiente -> contactado -> resuelto), para llevar
// el seguimiento de recuperación de clientes insatisfechos.
app.get("/quejas/:slug/estado", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const { slug } = req.params;
  const i = parseInt(req.query.i, 10);
  const nuevoEstado = req.query.estado;
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

// Genera el SVG de una tarjeta de testimonio lista para redes sociales (formato cuadrado, 1080x1080).
function tarjetaTestimonioSvg(frase, nombreNegocio, valor) {
  const estrellas = "★".repeat(valor) + "☆".repeat(5 - valor);
  const escapar = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
    <rect width="1080" height="1080" fill="${MARCA.crema}"/>
    <rect x="40" y="40" width="1000" height="1000" rx="36" fill="${MARCA.verdeOscuro}"/>
    <text x="540" y="300" font-family="Georgia, serif" font-size="180" fill="${MARCA.oro}" text-anchor="middle">&#8220;</text>
    <text x="540" y="540" font-family="Arial, sans-serif" font-size="58" font-weight="700" fill="#FFFFFF" text-anchor="middle">${escapar(frase)}</text>
    <text x="540" y="630" font-family="Arial, sans-serif" font-size="48" fill="${MARCA.oro}" text-anchor="middle" letter-spacing="6">${estrellas}</text>
    <text x="540" y="900" font-family="Arial, sans-serif" font-size="40" font-weight="700" fill="#FFFFFF" text-anchor="middle">${escapar(nombreNegocio)}</text>
    <text x="540" y="950" font-family="Arial, sans-serif" font-size="24" fill="#CFE3D8" text-anchor="middle">Reseña real via Tapin</text>
  </svg>`;
}

// Galería de testimonios positivos listos para convertir en contenido de redes.
// Visítalo así: https://tu-dominio.com/contenido/mi-negocio?key=TU_CLAVE
app.get("/contenido/:slug", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  if (!esPro(negocio)) {
    return res.status(402).send(
      `Esta función (generador de contenido para redes) es exclusiva del Plan Pro. ` +
      `Súbele el plan a "${negocio.nombre}" desde /editar/${slug}?key=${req.query.key} para activarla.`
    );
  }

  const datos = leerDatos();
  const testimonios = (datos[slug] && datos[slug].testimonios) || [];

  const tarjetas = testimonios
    .map((t, i) => i)
    .reverse()
    .map((i) => {
      const t = testimonios[i];
      const svgMini = tarjetaTestimonioSvg(t.frase, negocio.nombre, t.valor);
      const svgB64 = Buffer.from(svgMini).toString("base64");
      return `
        <div class="tarjeta">
          <img src="data:image/svg+xml;base64,${svgB64}" alt="${t.frase}">
          <div class="tarjeta-pie">
            <span>${t.fechaLegible}</span>
            <a href="/contenido/${slug}/tarjeta.svg?key=${req.query.key}&i=${i}" download>Descargar</a>
          </div>
        </div>`;
    })
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Contenido para redes — ${negocio.nombre}</title>
        <style>
          ${ESTILO_BASE}
          .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:18px;}
          .tarjeta{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.04);}
          .tarjeta img{width:100%;display:block;}
          .tarjeta-pie{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;font-size:0.78rem;color:${MARCA.textoSuave};}
          .tarjeta-pie a{font-weight:700;color:${MARCA.verde};text-decoration:none;}
        </style>
      </head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 22)}</div><a class="back" href="/stats?key=${req.query.key}">&larr; Volver al panel</a></div>
        <div class="content">
          <div class="eyebrow">Marketing automático</div>
          <h1 class="titulo-pagina">Contenido para redes — ${negocio.nombre}</h1>
          <div class="subtitulo">Cada vez que un cliente califica bien y elige una frase, se genera automáticamente una tarjeta lista para Instagram/Stories.</div>
          <div class="grid">
            ${tarjetas || "<p>Todavía no hay testimonios. Aparecerán aquí cuando los clientes califiquen positivo y elijan una frase.</p>"}
          </div>
        </div>
      </body>
    </html>
  `);
});

// Descarga el SVG individual de una tarjeta de testimonio.
app.get("/contenido/:slug/tarjeta.svg", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!esPro(negocio)) {
    return res.status(402).send("Esta función es exclusiva del Plan Pro.");
  }

  const datos = leerDatos();
  const testimonios = (datos[slug] && datos[slug].testimonios) || [];
  const i = parseInt(req.query.i, 10);
  const t = testimonios[i];
  if (!t) return res.status(404).send("Testimonio no encontrado.");

  const svg = tarjetaTestimonioSvg(t.frase, negocio.nombre, t.valor);
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Content-Disposition", `attachment; filename="tapin-${slug}-${i}.svg"`);
  res.send(svg);
});

// Panel individual de UN SOLO negocio, usando su propia clave (no la clave maestra).
// Así puedes darle este enlace al dueño sin que vea los datos de tus otros negocios.
// Incluye recomendaciones automáticas generadas a partir de sus propios datos.
// Visítalo así: https://tu-dominio.com/mi-panel/mi-negocio?key=CLAVE_DE_ESE_NEGOCIO
app.get("/mi-panel/:slug", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  if (!negocio.claveAcceso || req.query.key !== negocio.claveAcceso) {
    return res.status(401).send("No autorizado. Verifica el enlace que te dio Tapin, debe incluir tu clave personal (?key=...).");
  }

  const datos = leerDatos();
  const eventos = (datos[slug] && datos[slug].eventos) || [];
  const r = calcularResumen(eventos);
  const ultimoTexto = r.ultimo ? r.ultimo.fechaLegible : "Sin toques todavía";
  const recomendaciones = generarRecomendaciones(eventos, r, negocio);

  const recomendacionesHtml = recomendaciones
    .map((texto) => `<div class="reco">💡 ${texto}</div>`)
    .join("");

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
          .content{max-width:600px;}
          .seccion{margin-bottom:40px;}
          .seccion-header{text-align:center;margin-bottom:20px;}
          .seccion-header .eyebrow{justify-content:center;}
          .seccion-header h2{font-size:1.1rem;font-weight:700;margin:0 0 4px;}
          .seccion-header p{color:${MARCA.textoSuave};font-size:0.85rem;margin:0;}

          .resumen-grid{display:flex;gap:12px;flex-wrap:wrap;}
          .resumen-box{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;padding:20px 14px;text-align:center;
                       box-shadow:0 1px 2px rgba(11,61,44,0.04);flex:1;min-width:120px;}
          .resumen-num{font-size:1.8rem;font-weight:700;color:${MARCA.verdeOscuro};line-height:1;}
          .resumen-lbl{font-size:0.7rem;color:${MARCA.textoSuave};margin-top:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;}

          .chart-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:14px;padding:20px 22px;margin-top:14px;
                      box-shadow:0 1px 2px rgba(11,61,44,0.04);}
          .chart-card-titulo{font-size:0.8rem;font-weight:600;color:${MARCA.textoSuave};margin-bottom:16px;text-align:center;}
          .sparkline{display:flex;align-items:flex-end;gap:5px;}
          .sparkline-grande{height:100px;}

          .ultimo-toque{text-align:center;font-size:0.85rem;color:${MARCA.textoSuave};margin-top:14px;}
          .ultimo-toque b{color:${MARCA.texto};}

          .reco{background:${MARCA.verdeClaro};border-left:3px solid ${MARCA.verde};border-radius:8px;padding:14px 16px;
                font-size:0.86rem;margin-bottom:10px;color:${MARCA.verdeOscuro};}
        </style>
      </head>
      <body>
        <div class="topbar" style="justify-content:center;">
          <div>${logoSvg("#FFFFFF", 24)}</div>
        </div>
        <div class="content">

          <div class="seccion" style="text-align:center;">
            <div class="eyebrow" style="justify-content:center;">Panel del negocio</div>
            <h1 class="titulo-pagina">${negocio.nombre}</h1>
            <div class="subtitulo">Actualizado al ${new Date().toLocaleDateString("es-CO", { timeZone: zonaDe(negocio) })}</div>
          </div>

          <div class="seccion">
            <div class="resumen-grid">
              <div class="resumen-box"><div class="resumen-num">${r.total}</div><div class="resumen-lbl">Total</div></div>
              <div class="resumen-box"><div class="resumen-num">${r.hoy}</div><div class="resumen-lbl">Hoy</div></div>
              <div class="resumen-box"><div class="resumen-num">${r.semana}</div><div class="resumen-lbl">Últimos 7 días</div></div>
            </div>
            <div class="chart-card">
              <div class="chart-card-titulo">Toques de los últimos 7 días</div>
              <div class="sparkline sparkline-grande">${barraSemana(r.dias7)}</div>
            </div>
            <div class="ultimo-toque">Último toque: <b>${ultimoTexto}</b></div>
          </div>

          <div class="seccion">
            <div class="seccion-header">
              <div class="eyebrow">Para ti</div>
              <h2>Recomendaciones</h2>
              <p>Generadas automáticamente a partir de tu propia actividad.</p>
            </div>
            ${recomendacionesHtml}
          </div>

        </div>
      </body>
    </html>
  `);
});

// Mismo reporte que el PDF, pero para ver directo en el navegador sin descargar nada.
// Visítalo así: https://tu-dominio.com/reporte/mi-negocio?key=TU_CLAVE
app.get("/reporte/:slug", (req, res) => {
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
  const recomendacionesHtml = recomendaciones.map((texto) => `<div class="reco">💡 ${texto}</div>`).join("");

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
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
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
  const r = calcularResumen(eventos);
  const recomendaciones = generarRecomendaciones(eventos, r, negocio);
  const promSector = promedioSector(negocio.categoria, slug, datos);
  const horas = analizarHoras(eventos, negocio);
  const fechaGenerado = new Date().toLocaleDateString("es-CO", { timeZone: zonaDe(negocio), day: "numeric", month: "long", year: "numeric" });

  const pdfDoc = await PDFDocument.create();
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const verdeOscuro = rgb(0.043, 0.239, 0.173); // #0B3D2C
  const verde = rgb(0.059, 0.318, 0.196);       // #0F5132
  const verdeClaro = rgb(0.906, 0.941, 0.918);  // #E7F0EA
  const oro = rgb(0.788, 0.635, 0.294);         // #C9A24B
  const rojo = rgb(0.753, 0.224, 0.169);        // similar a MARCA.rojo
  const crema = rgb(0.980, 0.980, 0.973);       // #FAFAF8
  const oscuro = rgb(0.086, 0.125, 0.109);      // #16201C
  const gris = rgb(0.42, 0.46, 0.44);
  const blanco = rgb(1, 1, 1);

  const ANCHO = 595, ALTO = 842; // A4
  let numeroPagina = 0;

  function piePagina(page) {
    numeroPagina++;
    page.drawLine({ start: { x: 50, y: 56 }, end: { x: ANCHO - 50, y: 56 }, thickness: 0.5, color: verdeClaro });
    page.drawText("Tapin", { x: 50, y: 38, size: 9, font: fontBold, color: verde });
    page.drawText(`Informe de desempeño · ${negocio.nombre}`, { x: 90, y: 38, size: 8, font, color: gris });
    page.drawText(`${numeroPagina}`, { x: ANCHO - 60, y: 38, size: 8, font, color: gris });
  }

  function encabezadoSeccion(page, titulo) {
    page.drawRectangle({ x: 0, y: ALTO - 70, width: ANCHO, height: 70, color: verdeOscuro });
    page.drawText(titulo, { x: 50, y: ALTO - 44, size: 16, font: fontBold, color: blanco });
    page.drawText(negocio.nombre, { x: 50, y: ALTO - 60, size: 9, font, color: rgb(0.81, 0.89, 0.85) });
  }

  // ---------- Página 1: Portada ----------
  const portada = pdfDoc.addPage([ANCHO, ALTO]);
  portada.drawRectangle({ x: 0, y: 0, width: ANCHO, height: ALTO, color: verdeOscuro });
  portada.drawRectangle({ x: 0, y: ALTO - 8, width: ANCHO, height: 8, color: oro });
  portada.drawText("TAPIN", { x: 50, y: ALTO - 120, size: 34, font: fontBold, color: blanco });
  portada.drawText("Informe de desempeño", { x: 50, y: ALTO - 150, size: 14, font, color: rgb(0.81, 0.89, 0.85) });

  portada.drawLine({ start: { x: 50, y: ALTO - 200 }, end: { x: 250, y: ALTO - 200 }, thickness: 1.5, color: oro });
  portada.drawText(negocio.nombre, { x: 50, y: ALTO - 240, size: 26, font: fontBold, color: blanco });
  portada.drawText(`Categoría: ${negocio.categoria || "—"}`, { x: 50, y: ALTO - 264, size: 11, font, color: rgb(0.81, 0.89, 0.85) });
  portada.drawText(`Generado el ${fechaGenerado}`, { x: 50, y: ALTO - 282, size: 11, font, color: rgb(0.81, 0.89, 0.85) });

  portada.drawRectangle({ x: 50, y: 120, width: ANCHO - 100, height: 1, color: rgb(0.3, 0.45, 0.38) });
  portada.drawText("Preparado automáticamente a partir de la actividad real registrada en la tarjeta Tapin de este negocio.", {
    x: 50, y: 95, size: 9, font, color: rgb(0.7, 0.8, 0.75), maxWidth: ANCHO - 100, lineHeight: 13,
  });
  portada.drawText("Tapin", { x: 50, y: 50, size: 9, font: fontBold, color: oro });

  // ---------- Página 2: Resumen ejecutivo ----------
  const resumen = pdfDoc.addPage([ANCHO, ALTO]);
  encabezadoSeccion(resumen, "Resumen ejecutivo");

  let y = ALTO - 110;
  resumen.drawText("Métricas clave", { x: 50, y, size: 11, font: fontBold, color: oscuro });
  y -= 16;

  const metrics = [
    ["Toques totales", r.total],
    ["Toques hoy", r.hoy],
    ["Últimos 7 días", r.semana],
  ];
  let x = 50;
  metrics.forEach(([label, val]) => {
    resumen.drawRectangle({ x, y: y - 58, width: 158, height: 58, color: crema });
    resumen.drawRectangle({ x, y: y - 58, width: 4, height: 58, color: verde });
    resumen.drawText(String(val), { x: x + 16, y: y - 24, size: 22, font: fontBold, color: verde });
    resumen.drawText(label, { x: x + 16, y: y - 42, size: 8.5, font, color: gris });
    x += 168;
  });
  y -= 90;

  if (esPro(negocio) && promSector !== null) {
    const diferencia = r.semana - promSector;
    const texto = diferencia >= 0
      ? `Por encima del promedio de tu categoría (+${diferencia} toques/semana vs. ${promSector})`
      : `Por debajo del promedio de tu categoría (${diferencia} toques/semana vs. ${promSector})`;
    resumen.drawRectangle({ x: 50, y: y - 26, width: ANCHO - 100, height: 26, color: verdeClaro });
    resumen.drawText(texto, { x: 60, y: y - 17, size: 9, font: fontBold, color: verdeOscuro });
    y -= 46;
  }

  resumen.drawText("Toques por día (últimos 7 días)", { x: 50, y, size: 11, font: fontBold, color: oscuro });
  y -= 16;

  const max = Math.max(1, ...r.dias7);
  const nombresDias = [];
  const ahoraD = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(ahoraD);
    d.setDate(d.getDate() - i);
    nombresDias.push(d.toLocaleDateString("es-CO", { weekday: "short" }));
  }
  const barAreaTop = y;
  const barAreaHeight = 90;
  r.dias7.forEach((v, i) => {
    const barHeight = (v / max) * barAreaHeight;
    const bx = 50 + i * 70;
    resumen.drawRectangle({ x: bx, y: barAreaTop - barAreaHeight, width: 36, height: barHeight || 1, color: verde });
    resumen.drawText(String(v), { x: bx + 12, y: barAreaTop - barAreaHeight - 14, size: 9, font, color: gris });
    resumen.drawText(nombresDias[i], { x: bx, y: barAreaTop - barAreaHeight - 28, size: 9, font, color: oscuro });
  });

  y = barAreaTop - barAreaHeight - 60;
  resumen.drawText("Recomendaciones", { x: 50, y, size: 11, font: fontBold, color: oscuro });
  y -= 18;
  recomendaciones.forEach((texto) => {
    if (y < 90) return;
    resumen.drawRectangle({ x: 50, y: y - 28, width: ANCHO - 100, height: 28, color: crema });
    resumen.drawRectangle({ x: 50, y: y - 28, width: 3, height: 28, color: oro });
    resumen.drawText(texto, { x: 62, y: y - 18, size: 8.5, font, color: oscuro, maxWidth: ANCHO - 130, lineHeight: 11 });
    y -= 36;
  });
  piePagina(resumen);

  // ---------- Página 3: Análisis por horas — picos y caídas ----------
  const paginaHoras = pdfDoc.addPage([ANCHO, ALTO]);
  encabezadoSeccion(paginaHoras, "Picos y caídas por hora");

  y = ALTO - 108;
  paginaHoras.drawText("Basado en los últimos 30 días de actividad", { x: 50, y, size: 9, font, color: gris });
  y -= 24;

  // Tarjetas de pico y caída
  const horaTexto = (h) => `${h}:00 - ${(h + 1) % 24}:00`;
  const tarjetasHora = [
    ["Hora pico", horaTexto(horas.picoHora), `${horas.maxToques} toques`, verde],
    ["Hora más floja", horas.horaCaida != null ? horaTexto(horas.horaCaida) : "—", `${horas.minToques} toques`, rojo],
  ];
  x = 50;
  tarjetasHora.forEach(([label, hora, sub, color]) => {
    paginaHoras.drawRectangle({ x, y: y - 66, width: 246, height: 66, color: crema });
    paginaHoras.drawRectangle({ x, y: y - 66, width: 4, height: 66, color });
    paginaHoras.drawText(label, { x: x + 16, y: y - 20, size: 8.5, font, color: gris });
    paginaHoras.drawText(hora, { x: x + 16, y: y - 42, size: 18, font: fontBold, color: oscuro });
    paginaHoras.drawText(sub, { x: x + 16, y: y - 56, size: 8.5, font, color: gris });
    x += 256;
  });
  y -= 90;

  if (horas.totalMes > 0) {
    let textoTendencia;
    if (horas.tendenciaPico > 0) {
      textoTendencia = `La hora pico (${horaTexto(horas.picoHora)}) tuvo ${horas.tendenciaPico} toques más esta semana que la anterior — la actividad está subiendo.`;
    } else if (horas.tendenciaPico < 0) {
      textoTendencia = `La hora pico (${horaTexto(horas.picoHora)}) tuvo ${Math.abs(horas.tendenciaPico)} toques menos esta semana que la anterior — vale la pena revisar qué cambió.`;
    } else {
      textoTendencia = `La hora pico (${horaTexto(horas.picoHora)}) se mantuvo estable esta semana comparada con la anterior.`;
    }
    paginaHoras.drawRectangle({ x: 50, y: y - 30, width: ANCHO - 100, height: 30, color: verdeClaro });
    paginaHoras.drawText(textoTendencia, { x: 60, y: y - 20, size: 8.5, font: fontBold, color: verdeOscuro, maxWidth: ANCHO - 120, lineHeight: 11 });
    y -= 50;
  }

  paginaHoras.drawText("Distribución de toques por hora del día", { x: 50, y, size: 11, font: fontBold, color: oscuro });
  y -= 14;

  if (horas.totalMes === 0) {
    paginaHoras.drawText("Todavía no hay suficientes datos este mes para este análisis.", { x: 50, y: y - 20, size: 9, font, color: gris });
  } else {
    const graficoTop = y - 10;
    const graficoAltura = 180;
    const maxHora = Math.max(1, horas.maxToques);
    const anchoBarra = (ANCHO - 100) / 24;
    horas.porHora.forEach((v, h) => {
      const alturaBarra = (v / maxHora) * graficoAltura;
      const bx = 50 + h * anchoBarra;
      const esPico = h === horas.picoHora && v > 0;
      paginaHoras.drawRectangle({
        x: bx + 1, y: graficoTop - graficoAltura, width: anchoBarra - 2, height: alturaBarra || 0.5,
        color: esPico ? oro : verde,
      });
      // Etiqueta de hora cada 3 horas para no saturar
      if (h % 3 === 0) {
        paginaHoras.drawText(String(h), { x: bx + 1, y: graficoTop - graficoAltura - 12, size: 6.5, font, color: gris });
      }
    });
    paginaHoras.drawLine({
      start: { x: 50, y: graficoTop - graficoAltura }, end: { x: ANCHO - 50, y: graficoTop - graficoAltura },
      thickness: 0.5, color: gris,
    });
  }
  piePagina(paginaHoras);

  // ---------- Página 4: Detalle de interacciones ----------
  const detalle = pdfDoc.addPage([ANCHO, ALTO]);
  encabezadoSeccion(detalle, "Detalle de interacciones");

  y = ALTO - 110;
  detalle.drawText("Últimas interacciones registradas", { x: 50, y, size: 11, font: fontBold, color: oscuro });
  y -= 22;

  detalle.drawRectangle({ x: 50, y: y - 18, width: ANCHO - 100, height: 18, color: verdeOscuro });
  detalle.drawText("Fecha y hora", { x: 58, y: y - 13, size: 8.5, font: fontBold, color: blanco });
  detalle.drawText("Dispositivo", { x: 320, y: y - 13, size: 8.5, font: fontBold, color: blanco });
  y -= 18;

  const recientes = eventos.slice(-30).reverse();
  recientes.forEach((e, i) => {
    if (y < 90) return;
    if (i % 2 === 0) detalle.drawRectangle({ x: 50, y: y - 16, width: ANCHO - 100, height: 16, color: crema });
    detalle.drawText(e.fechaLegible, { x: 58, y: y - 12, size: 8.5, font, color: oscuro });
    detalle.drawText(e.dispositivo, { x: 320, y: y - 12, size: 8.5, font, color: oscuro });
    y -= 16;
  });
  if (recientes.length === 0) {
    detalle.drawText("Sin interacciones registradas todavía.", { x: 58, y: y - 12, size: 9, font, color: gris });
  }
  piePagina(detalle);

  return pdfDoc.save();
}

// Informe de entrega en Word (.docx) — editable, para que tú o el cliente lo
// personalicen, lo peguen en una propuesta, o lo usen como acta formal.
// Visítalo así: https://tu-dominio.com/export/mi-negocio.docx?key=TU_CLAVE
app.get("/export/:slug.docx", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
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
app.get("/entrega/:slug.pdf", async (req, res) => {
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
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }

  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
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

// Envía un reporte mensual completo por correo: métricas, recomendaciones automáticas
// y comparación contra el promedio del sector — no solo números, sino contexto.
// Esto NO se dispara solo — necesitas un servicio externo gratuito (cron-job.org)
// que visite esta URL una vez al mes. Ver instrucciones en el README.
// Visítalo así: https://tu-dominio.com/notificar/mi-negocio?key=TU_CLAVE
app.get("/notificar/:slug", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  // El reporte mensual (con picos y caídas por hora) vuelve a ser exclusivo
  // de Plan Pro, junto con el resto de exportaciones.
  if (!esPro(negocio)) {
    return res.status(402).send(
      `Esta función (reporte mensual por correo) es exclusiva del Plan Pro. ` +
      `Súbele el plan a "${negocio.nombre}" desde /editar/${slug}?key=${req.query.key} para activarla.`
    );
  }
  if (!negocio.email) {
    return res.status(400).send("Este negocio no tiene 'email' configurado. Agrégalo en /editar.");
  }

  const datos = leerDatos();
  const eventos = (datos[slug] && datos[slug].eventos) || [];
  const r = calcularResumen(eventos);
  const recomendaciones = generarRecomendaciones(eventos, r, negocio);
  const promedio = promedioSector(negocio.categoria, slug, datos);
  const horas = analizarHoras(eventos, negocio);

  let comparativo = "";
  // La comparación contra el promedio del sector sigue siendo exclusiva de
  // Plan Pro (así se anuncia en /conoce) — el resto del reporte ya es básico.
  if (esPro(negocio) && promedio !== null) {
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

  const filasBarra = barraSemana(r.dias7);
  const recosHtml = recomendaciones
    .map((texto) => `<div style="background:#F1F7F4;border-left:3px solid ${MARCA.verde};border-radius:8px;padding:12px 14px;font-size:0.88rem;margin-bottom:8px;color:#1F3D2E;">💡 ${texto}</div>`)
    .join("");

  // Generamos el informe completo en PDF (mismo que /export/:slug.pdf, con
  // picos/caídas incluidos) y lo adjuntamos al correo — así el reporte mensual
  // ya no es solo texto plano, es el documento completo listo para guardar o imprimir.
  const pdfBytes = await generarInformePDF(negocio, slug);

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
        <p style="font-size:0.78rem;color:#999;margin-top:12px;">Ver panel completo: ${req.protocol}://${req.get("host")}/mi-panel/${slug}?key=${negocio.claveAcceso || ""}</p>
      </div>
    `,
    [{ filename: `informe-tapin-${slug}.pdf`, content: Buffer.from(pdfBytes) }]
  );

  if (resultado.ok) {
    res.send(`Reporte mensual enviado a ${negocio.email}.`);
  } else {
    res.status(500).send("No se pudo enviar el correo: " + resultado.motivo);
  }
});

// Misma información en JSON, útil si luego quieres conectar esto a un dashboard propio.
// Misma información en JSON, útil para conectar la app móvil o un dashboard propio.
// Incluye nombre y categoría de cada negocio (no solo los eventos), para que
// la app no tenga que adivinar esa parte.
app.get("/stats.json", (req, res) => {
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
        <title>Conoce Tapin</title>
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
          .check{color:${MARCA.verde};font-weight:800;flex-shrink:0;}
          .cta{display:block;text-align:center;background:${MARCA.oro};color:#fff;text-decoration:none;
               padding:16px;border-radius:12px;font-weight:700;margin-top:60px;}
          .nota{background:${MARCA.verdeClaro};border-radius:12px;padding:18px 20px;margin-top:40px;font-size:0.86rem;color:${MARCA.verdeOscuro};}
        </style>
      </head>
      <body>
        <div class="hero">
          <div>${logoSvg("#FFFFFF", 34)}</div>
          <h1>Así funciona Tapin</h1>
          <p>Una tarjeta NFC que convierte cada visita en una reseña de Google — o en información privada que solo tú ves.</p>

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
          <div class="paso">
            <div class="paso-num">1</div>
            <div><h3>El cliente toca la tarjeta</h3><p>Con el celular pegado a la tarjeta (o escaneando el QR), se abre una página simple donde el cliente califica su experiencia.</p></div>
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

          <div class="seccion-titulo">Qué incluye cada plan</div>
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
              <ul>
                <li><span class="check">✓</span> Todo lo del pago único, más:</li>
                <li><span class="check">✓</span> Retroalimentación privada — lo negativo nunca se publica</li>
                <li><span class="check">✓</span> Alerta instantánea por correo ante retroalimentación negativa</li>
                <li><span class="check">✓</span> Registro completo de cada toque (fecha, hora, dispositivo)</li>
                <li><span class="check">✓</span> Reporte mensual automático con picos y caídas por hora</li>
                <li><span class="check">✓</span> Exportación de reportes en CSV, PDF y Word</li>
                <li><span class="check">✓</span> Generador de contenido para redes sociales</li>
                <li><span class="check">✓</span> Comparación contra el promedio de tu categoría</li>
              </ul>
            </div>
          </div>

          <div class="nota">
            <b>Sobre la retroalimentación:</b> cuando un cliente no tiene una buena experiencia, esa información nunca se convierte en una reseña pública negativa. Se queda contigo, en privado, como una oportunidad para mejorar o para contactar directamente a ese cliente — no como un golpe a tu reputación en línea.
          </div>

          <a class="cta" href="/pedido">Pedir mi tarjeta Tapin →</a>
        </div>
      </body>
    </html>
  `);
});


app.get("/descubre", (req, res) => {
  const todos = todosLosNegocios();
  const datos = leerDatos();
  const cliente = clienteActual(req);
  const misFavoritos = cliente ? (cliente.favoritos || []) : [];

  const puntos = Object.keys(todos)
    .map((slug) => ({ slug, negocio: todos[slug] }))
    .filter(({ negocio }) => negocio.lat != null && negocio.lng != null)
    .map(({ slug, negocio }) => {
      const rep = reputacionNegocio(slug, datos);
      return {
        slug,
        nombre: negocio.nombre,
        categoria: negocio.categoria || "negocio",
        direccion: negocio.direccion || "",
        lat: negocio.lat,
        lng: negocio.lng,
        googleUrl: negocio.googleUrl,
        esFavorito: misFavoritos.includes(slug),
        ...rep,
      };
    });

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
          .leyenda{position:absolute;bottom:20px;left:20px;z-index:900;background:#fff;border-radius:12px;
                   padding:12px 16px;box-shadow:0 4px 20px rgba(0,0,0,0.12);font-size:0.78rem;max-width:220px;}
          .leyenda-titulo{font-weight:700;margin-bottom:6px;color:${MARCA.texto};}
          .popup-nombre{font-weight:700;font-size:0.95rem;margin-bottom:2px;}
          .popup-cat{color:${MARCA.textoSuave};font-size:0.75rem;text-transform:capitalize;margin-bottom:6px;}
          .popup-estrellas{color:${MARCA.oro};font-size:0.9rem;margin-bottom:2px;}
          .popup-link{display:inline-block;margin-top:6px;background:${MARCA.verde};color:#fff;text-decoration:none;
                      padding:6px 12px;border-radius:100px;font-size:0.76rem;font-weight:600;}
          .popup-fav{display:inline-block;margin-top:6px;margin-left:6px;background:${MARCA.crema};color:${MARCA.texto};
                     text-decoration:none;padding:6px 12px;border-radius:100px;font-size:0.76rem;font-weight:600;
                     border:1px solid ${MARCA.borde};cursor:pointer;}
          .popup-fav.activo{background:${MARCA.oro};color:#fff;border-color:${MARCA.oro};}
          .vacio{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:900;text-align:center;
                 background:#fff;padding:24px 30px;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,0.12);}
        </style>
      </head>
      <body>
        <div class="topbar"><a class="back" href="/">&larr; Inicio</a><div>${logoSvg("#FFFFFF", 22)}</div><div style="width:60px;"></div></div>
        <div id="mapa"></div>
        <div class="leyenda">
          <div class="leyenda-titulo">Mapa de negocios Tapin</div>
          Entre más intenso el color, más actividad de clientes. Toca un punto para ver su reputación.
        </div>
        <script>
          const puntos = ${puntosJSON};
          const hayCliente = ${cliente ? "true" : "false"};
          const mapa = L.map('mapa').setView([${centroLat}, ${centroLng}], 12);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap'
          }).addTo(mapa);

          async function alternarFavorito(slug, boton) {
            if (!hayCliente) { window.location.href = '/cliente'; return; }
            const esFav = boton.classList.contains('activo');
            const ruta = esFav ? 'quitar' : 'guardar';
            await fetch('/favoritos/' + slug + '/' + ruta, { method: 'POST' });
            boton.classList.toggle('activo');
            boton.textContent = boton.classList.contains('activo') ? '★ Guardado' : '☆ Guardar';
          }

          if (puntos.length === 0) {
            document.querySelector('.leyenda').style.display = 'none';
            const div = document.createElement('div');
            div.className = 'vacio';
            div.innerHTML = '<b>Todavía no hay negocios con ubicación configurada.</b>';
            document.getElementById('mapa').parentElement.appendChild(div);
          } else {
            const heatData = puntos.map(p => [p.lat, p.lng, Math.max(0.3, Math.min(1, p.total / 50))]);
            L.heatLayer(heatData, { radius: 45, blur: 35, maxZoom: 15 }).addTo(mapa);

            puntos.forEach(p => {
              const estrellasHtml = '★'.repeat(p.estrellas) + '☆'.repeat(5 - p.estrellas);
              const marker = L.circleMarker([p.lat, p.lng], {
                radius: 8, color: '#0F5132', fillColor: '#C9A24B', fillOpacity: 0.9, weight: 2
              }).addTo(mapa);

              const contenedor = document.createElement('div');
              contenedor.innerHTML =
                '<div class="popup-nombre">' + p.nombre + '</div>' +
                '<div class="popup-cat">' + p.categoria + '</div>' +
                '<div class="popup-estrellas">' + estrellasHtml + ' (' + p.porcentaje + '% positivas)</div>' +
                (p.direccion ? '<div style="font-size:0.78rem;color:#888;">' + p.direccion + '</div>' : '') +
                '<a class="popup-link" href="' + p.googleUrl + '" target="_blank">Ver en Google</a>';

              const botonFav = document.createElement('button');
              botonFav.className = 'popup-fav' + (p.esFavorito ? ' activo' : '');
              botonFav.textContent = p.esFavorito ? '★ Guardado' : '☆ Guardar';
              botonFav.onclick = function () { alternarFavorito(p.slug, botonFav); };
              contenedor.appendChild(botonFav);

              marker.bindPopup(contenedor);
            });
          }
        </script>
      </body>
    </html>
  `);
});

// ---------- Dashboard de dueños: login mágico por correo, sin contraseña ----------
// Un dueño puede tener varios locales (varios slugs) — se agrupan por email.
app.get("/mis-negocios", (req, res) => {
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
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 30)}</div>
          <h1>Panel de tu negocio</h1>
          <p>Escribe el correo con el que registraste tu(s) tarjeta(s) Tapin. Te mandamos un link de acceso, sin contraseña que recordar.</p>
          <form method="POST" action="/mis-negocios/solicitar">
            <input type="email" name="email" required placeholder="tu@negocio.com">
            <button type="submit">Enviarme el acceso</button>
          </form>
        </div>
      </body>
    </html>
  `);
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

  const todos = todosLosNegocios();
  const datos = leerDatos();
  const misSlugs = Object.keys(todos).filter(
    (slug) => (todos[slug].email || "").trim().toLowerCase() === entrada.email
  );

  const tarjetas = misSlugs.map((slug) => {
    const negocio = todos[slug];
    const r = calcularResumen((datos[slug] && datos[slug].eventos) || []);
    return `
      <a class="card" href="/mi-panel/${slug}?key=${negocio.claveAcceso || ""}">
        <div class="card-top">
          <div class="card-nombre">${negocio.nombre} ${esPro(negocio) ? `<span class="badge-pro">PRO</span>` : `<span class="badge-basico">BÁSICO</span>`}</div>
          <div class="card-total">${r.total}<span>toques totales</span></div>
        </div>
        <div class="card-meta">${negocio.categoria || "—"} ${negocio.direccion ? "· " + negocio.direccion : ""}</div>
        <div class="card-cta">Ver panel completo &rarr;</div>
      </a>`;
  }).join("");

  res.send(`
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
        <div class="topbar"><div>${logoSvg("#FFFFFF", 22)}</div><a class="back" href="/">Inicio</a></div>
        <div class="content">
          <div class="eyebrow">Panel de dueño</div>
          <h1 class="titulo-pagina">Tus negocios</h1>
          <div class="subtitulo">${misSlugs.length} ${misSlugs.length === 1 ? "local registrado" : "locales registrados"} con este correo.</div>
          <div class="grid">${tarjetas || "<p>No encontramos negocios asociados a este correo.</p>"}</div>
        </div>
      </body>
    </html>
  `);
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
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 28)}</div>
          <div class="tabs">
            <div class="tab activo" id="tab-login" onclick="mostrar('login')">Iniciar sesión</div>
            <div class="tab" id="tab-registro" onclick="mostrar('registro')">Crear cuenta</div>
          </div>
          ${error ? `<div class="error">${error === "credenciales" ? "Correo o contraseña incorrectos." : error === "existe" ? "Ya existe una cuenta con ese correo." : "Faltan datos."}</div>` : ""}

          <div class="panel activo" id="panel-login">
            <h2>Bienvenido de vuelta</h2>
            <p>Entra para ver tus favoritos y tu historial de reseñas.</p>
            <form method="POST" action="/cliente/login">
              <input type="email" name="email" required placeholder="Correo electrónico">
              <div class="campo-clave">
                <input type="password" id="clave-login" name="password" required placeholder="Contraseña">
                <button type="button" class="ver-clave" id="boton-clave-login" onclick="alternarClave('clave-login')">${ICONO_OJO_ABIERTO}</button>
              </div>
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

app.post("/cliente/registro", (req, res) => {
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

app.post("/cliente/login", (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  const clientes = leerClientes();
  const entrada = Object.entries(clientes).find(([, c]) => c.email === email);
  if (!entrada || !verificarPassword(password, entrada[1].salt, entrada[1].hash)) {
    return res.redirect("/cliente?error=credenciales");
  }

  iniciarSesionCliente(res, entrada[0]);
  res.redirect("/cuenta");
});

app.get("/cliente/salir", (req, res) => {
  const cookies = leerCookies(req);
  if (cookies.tapin_sesion) {
    const sesiones = leerSesionesClientes();
    delete sesiones[cookies.tapin_sesion];
    guardarSesionesClientes(sesiones);
  }
  res.setHeader("Set-Cookie", "tapin_sesion=; HttpOnly; Path=/; Max-Age=0");
  res.redirect("/");
});

// Panel del cliente: sus favoritos y su historial de reseñas.
app.get("/cuenta", (req, res) => {
  const cliente = clienteActual(req);
  if (!cliente) return res.redirect("/cliente");

  const todos = todosLosNegocios();

  const favoritosHtml = (cliente.favoritos || [])
    .filter((slug) => todos[slug])
    .map((slug) => {
      const n = todos[slug];
      return `
        <div class="fav-card">
          <div>
            <div class="fav-nombre">${n.nombre}</div>
            <div class="fav-cat">${n.categoria || "—"} ${n.direccion ? "· " + n.direccion : ""}</div>
          </div>
          <div class="fav-acciones">
            <a href="${n.googleUrl}" target="_blank">Ver en Google</a>
            <a href="#" onclick="quitar('${slug}');return false;" class="quitar">Quitar</a>
          </div>
        </div>`;
    }).join("");

  const historialHtml = (cliente.historial || [])
    .slice()
    .reverse()
    .map((h) => `
      <div class="hist-fila">
        <div>
          <b>${h.negocioNombre}</b>
          <span class="hist-fecha">${h.fecha}</span>
        </div>
        <div class="hist-estrellas">${"★".repeat(h.valor)}${"☆".repeat(5 - h.valor)}</div>
      </div>`
    ).join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Mi cuenta — Tapin</title>
        <style>
          ${ESTILO_BASE}
          .seccion-titulo{font-size:1.05rem;font-weight:700;margin:32px 0 14px;}
          .fav-card{background:#fff;border:1px solid ${MARCA.borde};border-radius:12px;padding:16px 18px;
                    display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
          .fav-nombre{font-weight:700;font-size:0.95rem;}
          .fav-cat{color:${MARCA.textoSuave};font-size:0.78rem;text-transform:capitalize;}
          .fav-acciones a{font-size:0.78rem;font-weight:700;text-decoration:none;margin-left:14px;}
          .fav-acciones .quitar{color:${MARCA.rojo};}
          .hist-fila{background:#fff;border:1px solid ${MARCA.borde};border-radius:12px;padding:14px 18px;
                     display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
          .hist-fecha{color:${MARCA.textoSuave};font-size:0.76rem;display:block;}
          .hist-estrellas{color:${MARCA.oro};}
          .vacio-msg{color:${MARCA.textoSuave};font-size:0.85rem;background:#fff;padding:20px;border-radius:12px;
                     border:1px dashed ${MARCA.borde};}
        </style>
      </head>
      <body>
        <div class="topbar">
          <div>${logoSvg("#FFFFFF", 22)}</div>
          <a class="back" href="/cliente/salir">Cerrar sesión</a>
        </div>
        <div class="content">
          <div class="eyebrow">Mi cuenta</div>
          <h1 class="titulo-pagina">Hola, ${cliente.nombre.split(" ")[0]}</h1>
          <div class="subtitulo">${cliente.email}</div>

          <div class="seccion-titulo">Tus negocios favoritos</div>
          ${favoritosHtml || `<div class="vacio-msg">Todavía no has guardado ningún negocio. Explora el <a href="/descubre">mapa de negocios</a> y guárdalos desde ahí.</div>`}

          <div class="seccion-titulo">Tu historial de reseñas</div>
          ${historialHtml || `<div class="vacio-msg">Todavía no has calificado ningún negocio con Tapin.</div>`}
        </div>
        <script>
          async function quitar(slug) {
            await fetch('/favoritos/' + slug + '/quitar', { method: 'POST' });
            location.reload();
          }
        </script>
      </body>
    </html>
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
app.get("/test-email", async (req, res) => {
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
    "✅ Correo de prueba — Tapin",
    `<p>Si ves esto, el envío de correos está funcionando correctamente.</p>
     <p style="color:#888;font-size:0.85rem;">Enviado desde /test-email el ${new Date().toLocaleString("es-CO")}</p>`
  );

  if (resultado.ok) {
    res.send(`✅ Correo enviado exitosamente a ${destino}. Revisa la bandeja de entrada (y spam).`);
  } else {
    res.status(500).send(`❌ Falló el envío. Motivo exacto: ${resultado.motivo}`);
  }
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Tapin</title>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <style>
          *{box-sizing:border-box;}
          html, body{height:100%;}
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;margin:0;}

          .hero{display:flex;min-height:100vh;}
          .hero-izq{flex:1;background:
                       radial-gradient(circle at 15% 85%, #1A4A36 0%, transparent 45%),
                       radial-gradient(circle at 90% 15%, #0D2E20 0%, transparent 50%),
                       linear-gradient(160deg, #16473368 0%, ${MARCA.verdeOscuro} 55%, #0A2A1D 100%);
                     color:#fff;padding:64px 56px;
                     display:flex;flex-direction:column;justify-content:center;position:relative;overflow:hidden;}
          .hero-izq::before{content:"";position:absolute;top:-30%;right:-30%;width:70%;height:70%;
                             background:radial-gradient(circle, ${MARCA.oro}22 0%, transparent 70%);}
          .hero-izq::after{content:"";position:absolute;inset:0;opacity:0.5;pointer-events:none;
                            background-image:radial-gradient(rgba(255,255,255,0.09) 1px, transparent 1px);
                            background-size:22px 22px;}
          .forma-organica{position:absolute;bottom:-18%;left:-12%;width:60%;height:60%;
                           background:${MARCA.oro};opacity:0.08;border-radius:42% 58% 65% 35% / 45% 40% 60% 55%;
                           filter:blur(2px);}
          .forma-organica-2{position:absolute;top:8%;left:52%;width:34%;height:34%;
                             background:#FFFFFF;opacity:0.04;border-radius:60% 40% 55% 45% / 50% 60% 40% 50%;}
          .logo-hero{font-size:4.2rem;font-weight:800;letter-spacing:-0.03em;margin:0 0 18px;position:relative;z-index:1;}
          .tagline{font-size:1.3rem;font-weight:400;color:#E4EEE8;line-height:1.5;margin:0 0 44px;max-width:420px;position:relative;z-index:1;}
          .botones{display:flex;flex-direction:column;gap:12px;max-width:360px;position:relative;z-index:1;}
          .boton-hero{display:block;background:rgba(255,255,255,0.97);border-radius:14px;padding:18px 22px;
                       text-decoration:none;transition:transform 0.15s;box-shadow:0 8px 24px rgba(0,0,0,0.2);}
          .boton-hero:active{transform:scale(0.98);}
          .boton-hero-titulo{font-size:1rem;font-weight:700;color:${MARCA.texto};}
          .boton-hero-desc{font-size:0.8rem;color:${MARCA.textoSuave};margin-top:2px;}
          .boton-hero.oro{background:${MARCA.oro};}
          .boton-hero.oro .boton-hero-titulo, .boton-hero.oro .boton-hero-desc{color:#fff;}
          .admin-link{display:inline-block;margin-top:36px;color:rgba(255,255,255,0.35);font-size:0.75rem;
                      text-decoration:none;position:relative;z-index:1;}
          .admin-link:hover{color:rgba(255,255,255,0.6);}

          .franja-features{display:flex;gap:36px;margin-top:56px;padding-top:32px;
                            border-top:1px solid rgba(255,255,255,0.15);position:relative;z-index:1;flex-wrap:wrap;}
          .feature{display:flex;align-items:center;gap:12px;}
          .feature-icono{width:38px;height:38px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.4);
                          display:flex;align-items:center;justify-content:center;flex-shrink:0;}
          .feature-titulo{font-size:0.85rem;font-weight:700;}
          .feature-desc{font-size:0.72rem;color:#B9CCC2;}

          .hero-der{flex:1;background:#EEF3EC;position:relative;display:flex;align-items:center;justify-content:center;
                    padding:40px;overflow:hidden;}
          #mapa-fondo{position:absolute;top:8%;left:10%;width:80%;height:84%;border-radius:24px;
                      box-shadow:0 20px 60px rgba(0,0,0,0.18);filter:saturate(0.7) brightness(1.02);}
          .mock-buscar{position:absolute;top:10%;left:13%;width:74%;background:#fff;border-radius:100px;
                       padding:14px 20px;font-size:0.85rem;color:#9aa39d;box-shadow:0 6px 18px rgba(0,0,0,0.1);
                       display:flex;justify-content:space-between;align-items:center;z-index:2;}
          .mock-card{position:absolute;bottom:8%;right:6%;width:340px;background:#fff;border-radius:18px;
                     box-shadow:0 20px 50px rgba(0,0,0,0.22);overflow:hidden;z-index:3;}
          .mock-foto{height:110px;background:linear-gradient(135deg, ${MARCA.verde} 0%, ${MARCA.verdeOscuro} 100%);
                     position:relative;}
          .mock-foto::after{content:"";position:absolute;inset:0;
                             background:repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0 2px, transparent 2px 14px);}
          .mock-info{padding:16px 18px 12px;}
          .mock-nombre{font-weight:700;font-size:1rem;color:${MARCA.texto};}
          .mock-cat{font-size:0.78rem;color:${MARCA.textoSuave};margin:2px 0 6px;}
          .mock-estrellas{color:${MARCA.oro};font-size:0.85rem;}
          .mock-num{color:${MARCA.textoSuave};font-size:0.78rem;margin-left:4px;}
          .mock-resenas{padding:12px 18px 18px;border-top:1px solid ${MARCA.borde};}
          .mock-resenas-titulo{font-size:0.78rem;font-weight:700;color:${MARCA.texto};margin-bottom:10px;}
          .mock-resena{display:flex;gap:10px;margin-bottom:10px;}
          .mock-avatar{width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;
                       justify-content:center;color:#fff;font-size:0.7rem;font-weight:700;}
          .mock-resena-cuerpo{flex:1;}
          .mock-resena-linea1{display:flex;justify-content:space-between;font-size:0.76rem;}
          .mock-resena-nombre{font-weight:700;color:${MARCA.texto};}
          .mock-resena-fecha{color:${MARCA.textoSuave};}
          .mock-resena-texto{font-size:0.76rem;color:${MARCA.textoSuave};margin-top:1px;}

          @media (max-width: 980px){
            .hero{flex-direction:column;}
            .hero-der{min-height:480px;}
            .mock-card{width:82%;right:9%;}
            .logo-hero{font-size:3rem;}
          }
          @media (max-width: 560px){
            .hero-izq{padding:44px 26px;}
            .franja-features{flex-direction:column;gap:16px;}
            .mock-card{width:88%;right:6%;bottom:5%;}
          }
        </style>
      </head>
      <body>
        <div class="hero">
          <div class="hero-izq">
            <div class="forma-organica"></div>
            <div class="forma-organica-2"></div>
            <div class="logo-hero">${logoSvg("#FFFFFF", 68)}</div>
            <p class="tagline">Descubre negocios locales.<br>Confía en lo que encuentras.</p>

            <div class="botones">
              <a class="boton-hero" href="/conoce">
                <div class="boton-hero-titulo">Conoce Tapin</div>
                <div class="boton-hero-desc">Cómo funciona la tarjeta y qué incluye cada plan</div>
              </a>
              <a class="boton-hero" href="/descubre">
                <div class="boton-hero-titulo">Descubrir negocios</div>
                <div class="boton-hero-desc">Mira el mapa de negocios que usan Tapin y su reputación</div>
              </a>
              <a class="boton-hero" href="/cliente">
                <div class="boton-hero-titulo">Soy cliente</div>
                <div class="boton-hero-desc">Crea tu cuenta — guarda favoritos y tu historial de reseñas</div>
              </a>
              <a class="boton-hero oro" href="/mis-negocios">
                <div class="boton-hero-titulo">Soy un negocio</div>
                <div class="boton-hero-desc">Entra a tu panel — tus locales, tus estadísticas</div>
              </a>
            </div>

            <a class="admin-link" href="/pedido" style="margin-top:18px;">¿Todavía no tienes tarjeta? Pídela aquí →</a>

            <div class="franja-features">
              <div class="feature">
                <div class="feature-icono">★</div>
                <div>
                  <div class="feature-titulo">Favoritos</div>
                  <div class="feature-desc">Guarda los lugares que te gustan</div>
                </div>
              </div>
              <div class="feature">
                <div class="feature-icono">⏱</div>
                <div>
                  <div class="feature-titulo">Historial de reseñas</div>
                  <div class="feature-desc">Todas tus calificaciones en un solo lugar</div>
                </div>
              </div>
              <div class="feature">
                <div class="feature-icono">↗</div>
                <div>
                  <div class="feature-titulo">Estadísticas del negocio</div>
                  <div class="feature-desc">Sigue tu reputación y crecimiento</div>
                </div>
              </div>
            </div>

            <a class="admin-link" href="/admin">Entrar como administrador</a>
          </div>

          <div class="hero-der">
            <div id="mapa-fondo"></div>
            <div class="mock-buscar"><span>Buscar negocios o lugares</span><span>🔍</span></div>

            <div class="mock-card">
              <div class="mock-foto"></div>
              <div class="mock-info">
                <div class="mock-nombre">Café Central</div>
                <div class="mock-cat">Cafetería · Centro</div>
                <div><span class="mock-estrellas">★★★★★</span><span class="mock-num">4.8 (312)</span></div>
              </div>
              <div class="mock-resenas">
                <div class="mock-resenas-titulo">Lo que dicen los clientes</div>
                <div class="mock-resena">
                  <div class="mock-avatar" style="background:${MARCA.verde};">SL</div>
                  <div class="mock-resena-cuerpo">
                    <div class="mock-resena-linea1"><span class="mock-resena-nombre">Sofía L.</span><span class="mock-resena-fecha">hace 2 días</span></div>
                    <div class="mock-resena-texto">Excelente café y ambiente muy acogedor.</div>
                  </div>
                </div>
                <div class="mock-resena">
                  <div class="mock-avatar" style="background:${MARCA.oro};">JT</div>
                  <div class="mock-resena-cuerpo">
                    <div class="mock-resena-linea1"><span class="mock-resena-nombre">Juan T.</span><span class="mock-resena-fecha">hace 1 semana</span></div>
                    <div class="mock-resena-texto">Atención muy amable, me encantó el lugar.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <script>
          // Mapa puramente decorativo: sin zoom, sin arrastre, sin controles.
          const mapaFondo = L.map('mapa-fondo', {
            center: [4.7110, -74.0721],
            zoom: 13,
            zoomControl: false,
            dragging: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            touchZoom: false,
            attributionControl: false,
          });
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(mapaFondo);
        </script>
      </body>
    </html>
  `);
});

// Puerta discreta de administrador — no aparece como botón grande en la página
// principal, solo un link chiquito abajo. Pide la clave y redirige al panel.
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
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 26)}</div>
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

app.get("/admin/entrar", (req, res) => {
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
               margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
          .box{background:#fff;border-radius:18px;padding:34px 30px;max-width:420px;width:100%;
               box-shadow:0 10px 40px rgba(0,0,0,0.08);}
          .logo{margin-bottom:6px;}
          h1{font-size:1.2rem;color:${MARCA.texto};margin:14px 0 4px;}
          p{color:${MARCA.textoSuave};font-size:0.85rem;margin:0 0 22px;}
          label{display:block;font-size:0.78rem;font-weight:700;color:${MARCA.texto};margin:0 0 5px;}
          input,select{width:100%;padding:12px;border:1px solid ${MARCA.borde};border-radius:10px;font-size:0.9rem;
                margin-bottom:14px;font-family:inherit;}
          .precio{background:${MARCA.verdeClaro};color:${MARCA.verdeOscuro};padding:14px 16px;border-radius:10px;
                   font-weight:700;text-align:center;margin-bottom:18px;}
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
          <div class="precio">Plan Básico — $${PRECIO_BASICO_COP.toLocaleString("es-CO")} COP (incluye envío)</div>
          <form method="POST" action="/pedido">
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
              <input type="checkbox" name="incluirPro" value="si">
              <span class="txt">
                <b>Incluir primer mes de Plan Pro (+$${PRECIO_PRO_COP.toLocaleString("es-CO")} COP)</b>
                Rescate de reseñas negativas en tiempo real, reportes mensuales y más. Se cobra junto con tu tarjeta en este mismo pago.
              </span>
            </label>

            <button type="submit">Continuar al pago</button>
          </form>
        </div>

        <script>
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
  const { nombreNegocio, email, telefono, direccion, ciudad, departamento, incluirPro } = req.body;
  if (!nombreNegocio || !email || !telefono || !direccion || !ciudad || !departamento) {
    return res.status(400).send("Faltan datos del pedido.");
  }

  const proIncluido = incluirPro === "si";
  const monto = PRECIO_BASICO_COP + (proIncluido ? PRECIO_PRO_COP : 0);

  const pedidos = leerPedidos();
  const id = generarToken();
  pedidos[id] = {
    nombreNegocio, email, telefono, direccion, ciudad, departamento,
    proIncluido,
    monto,
    estado: "pendiente", // pendiente | aprobado | rechazado
    creado: new Date().toISOString(),
  };
  guardarPedidos(pedidos);

  res.redirect(`/pagar/${id}`);
});

// Página de pago — embebe el widget oficial de Wompi con la firma de integridad
// calculada en el servidor (nunca se expone el secreto al navegador).
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
            <div style="margin-top:8px;"><b>Plan Básico:</b> $${PRECIO_BASICO_COP.toLocaleString("es-CO")} COP</div>
            ${pedido.proIncluido ? `<div><b>Primer mes Plan Pro:</b> $${PRECIO_PRO_COP.toLocaleString("es-CO")} COP</div>` : ""}
          </div>
          <div class="monto">$${pedido.monto.toLocaleString("es-CO")} COP</div>

          <form action="https://checkout.wompi.co/p/" method="GET">
            <input type="hidden" name="public-key" value="${process.env.WOMPI_PUBLIC_KEY}" />
            <input type="hidden" name="currency" value="${moneda}" />
            <input type="hidden" name="amount-in-cents" value="${montoCentavos}" />
            <input type="hidden" name="reference" value="${referencia}" />
            <input type="hidden" name="signature:integrity" value="${firma}" />
            <input type="hidden" name="redirect-url" value="${redirectUrl}" />
            <input type="hidden" name="shipping-address:address-line-1" value="${pedido.direccion}" />
            <input type="hidden" name="shipping-address:city" value="${pedido.ciudad}" />
            <input type="hidden" name="shipping-address:region" value="${pedido.departamento}" />
            <input type="hidden" name="shipping-address:phone-number" value="${pedido.telefono}" />
            <input type="hidden" name="shipping-address:country" value="CO" />
            <button type="submit">Pagar con Wompi</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

// Wompi redirige aquí después del pago, con ?id=TRANSACTION_ID en la URL.
// Consultamos el estado real de la transacción contra la API de Wompi (nunca
// confiamos solo en lo que diga la URL, porque se podría manipular).
// Verifica que un aviso de webhook realmente venga de Wompi (y no de cualquiera
// que le pegue a la URL). Compara un checksum SHA256 calculado con el "Secreto
// de Eventos" (distinto del Secreto de Integridad) que Wompi te da en su panel.
// Basado en el algoritmo documentado por Wompi — si algo no cuadra, revisa su
// documentación oficial de eventos antes de confiar ciegamente en producción.
function verificarChecksumWompi(payload) {
  if (!process.env.WOMPI_EVENTS_SECRET) return false;
  if (!payload || !payload.signature || !payload.signature.properties) return false;

  try {
    const valores = payload.signature.properties.map((ruta) => {
      // Cada "ruta" es algo como "transaction.id" o "transaction.status" —
      // navegamos el objeto payload.data siguiendo esos nombres.
      return ruta.split(".").reduce((obj, key) => (obj ? obj[key] : undefined), payload.data);
    });
    const cadena = valores.join("") + payload.timestamp + process.env.WOMPI_EVENTS_SECRET;
    const checksumCalculado = crypto.createHash("sha256").update(cadena).digest("hex").toUpperCase();
    return checksumCalculado === String(payload.signature.checksum).toUpperCase();
  } catch (err) {
    console.error("Error verificando checksum de Wompi:", err.message);
    return false;
  }
}

// Wompi le pega a esta URL automáticamente cada vez que cambia el estado de una
// transacción — así el pedido se marca como pagado aunque el cliente cierre el
// navegador antes de volver a /pago-confirmado.
// Configúrala en Wompi: Desarrollo → "URL de Eventos" → pega esta URL completa:
// https://tu-dominio.com/webhook/wompi
app.post("/webhook/wompi", (req, res) => {
  const payload = req.body;

  if (!verificarChecksumWompi(payload)) {
    console.error("[webhook Wompi] checksum inválido o secreto no configurado — aviso ignorado.");
    return res.status(400).json({ ok: false, motivo: "Checksum inválido." });
  }

  const transaccion = payload?.data?.transaction;
  if (!transaccion) return res.status(400).json({ ok: false, motivo: "Sin datos de transacción." });

  // La referencia que generamos al crear el pedido tiene el formato "tapin-ID".
  const referencia = transaccion.reference || "";
  const pedidoId = referencia.startsWith("tapin-") ? referencia.slice("tapin-".length) : null;

  if (pedidoId) {
    const pedidos = leerPedidos();
    if (pedidos[pedidoId]) {
      if (transaccion.status === "APPROVED") {
        pedidos[pedidoId].estado = "aprobado";
      } else if (transaccion.status === "DECLINED" || transaccion.status === "ERROR") {
        pedidos[pedidoId].estado = "rechazado";
      }
      guardarPedidos(pedidos);
      console.log(`[webhook Wompi] pedido ${pedidoId} actualizado a "${pedidos[pedidoId].estado}"`);
    }
  }

  // Wompi solo necesita un 200 OK para saber que el aviso llegó bien.
  res.status(200).json({ ok: true });
});

app.get("/pago-confirmado", async (req, res) => {
  const pedidoId = req.query.pedido;
  const transaccionId = req.query.id;
  const pedidos = leerPedidos();
  const pedido = pedidos[pedidoId];

  let estado = "desconocido";
  let mensaje = "No pudimos confirmar el estado de tu pago automáticamente.";

  if (transaccionId && process.env.WOMPI_PUBLIC_KEY) {
    try {
      const base = process.env.WOMPI_PUBLIC_KEY.startsWith("pub_prod_")
        ? "https://production.wompi.co/v1"
        : "https://sandbox.wompi.co/v1";
      const resp = await fetch(`${base}/transactions/${transaccionId}`);
      const data = await resp.json();
      estado = data?.data?.status || "desconocido";
    } catch (err) {
      console.error("Error consultando transacción Wompi:", err.message);
    }
  }

  if (pedido) {
    if (estado === "APPROVED") {
      pedido.estado = "aprobado";
      mensaje = pedido.proIncluido
        ? "¡Pago aprobado! Tu tarjeta Tapin va en camino, con tu primer mes de Plan Pro ya incluido."
        : "¡Pago aprobado! Tu tarjeta Tapin va en camino.";
    } else if (estado === "DECLINED" || estado === "ERROR") {
      pedido.estado = "rechazado";
      mensaje = "El pago no pudo procesarse. Puedes intentar de nuevo.";
    } else if (estado === "PENDING") {
      mensaje = "Tu pago está siendo procesado. Te avisamos por correo cuando se confirme.";
    }
    pedidos[pedidoId] = pedido;
    guardarPedidos(pedidos);
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

// ---------- Cobro automático de la mensualidad Pro (pagos recurrentes) ----------
// Wompi maneja suscripciones así: el dueño del negocio registra su tarjeta UNA
// sola vez (se tokeniza, nunca guardamos el número real), Wompi nos da un
// "payment_source_id" reutilizable, y luego cada mes el SERVIDOR le cobra a esa
// fuente de pago directamente vía API — sin que el dueño tenga que volver a
// ingresar nada. Necesitas UNA variable de entorno nueva en Render:
//   WOMPI_PRIVATE_KEY → tu "Llave privada" (prv_test_... o prv_prod_...),
//   distinta de la pública y de los secretos de integridad/eventos. Se usa
//   SOLO aquí en el servidor — nunca se envía al navegador.

function baseWompi() {
  return (process.env.WOMPI_PUBLIC_KEY || "").startsWith("pub_prod_")
    ? "https://production.wompi.co/v1"
    : "https://sandbox.wompi.co/v1";
}
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

// Página donde el dueño de un negocio Pro registra su tarjeta una sola vez,
// usando el Widget de Wompi en modo "tokenize" (no cobra nada en este paso).
app.get("/suscripcion/:slug", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!negocio.claveAcceso || req.query.key !== negocio.claveAcceso) {
    return res.status(401).send("No autorizado.");
  }
  if (!esPro(negocio)) {
    return res.status(402).send("Esta página es solo para negocios en Plan Pro.");
  }
  if (!process.env.WOMPI_PUBLIC_KEY) {
    return res.status(500).send("Los pagos todavía no están configurados (falta WOMPI_PUBLIC_KEY en Render).");
  }

  const sus = negocio.suscripcion;
  const activa = !!(sus && sus.activa && sus.paymentSourceId);

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Suscripción Pro — ${negocio.nombre}</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:'Inter','Segoe UI',-apple-system,Arial,sans-serif;background:${MARCA.crema};
               margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
          .box{background:#fff;border-radius:18px;padding:34px 30px;max-width:420px;width:100%;text-align:center;
               box-shadow:0 10px 40px rgba(0,0,0,0.08);}
          h1{font-size:1.1rem;color:${MARCA.texto};margin:14px 0 6px;}
          p{color:${MARCA.textoSuave};font-size:0.85rem;}
          .estado{padding:12px 16px;border-radius:10px;font-weight:700;margin:16px 0;font-size:0.85rem;
                  background:${activa ? MARCA.verdeClaro : "#fff4e0"};color:${activa ? MARCA.verdeOscuro : "#8a5a00"};}
        </style>
      </head>
      <body>
        <div class="box">
          <div class="logo">${logoSvg(MARCA.verdeOscuro, 26)}</div>
          <h1>Suscripción Plan Pro — ${negocio.nombre}</h1>
          ${activa
            ? `<div class="estado">✅ Tarjeta registrada. Se cobra automáticamente $${PRECIO_PRO_COP.toLocaleString("es-CO")} COP cada mes.</div>
               <p>Próximo cobro: ${sus.proximoCobro ? new Date(sus.proximoCobro).toLocaleDateString("es-CO") : "pendiente"}</p>
               <p>¿Cambiaste de tarjeta? Registra una nueva abajo y reemplazará la anterior.</p>`
            : `<p>Registra tu tarjeta una sola vez. <b>No se te cobra nada en este paso</b> — solo queda guardada para el cobro automático de $${PRECIO_PRO_COP.toLocaleString("es-CO")} COP/mes.</p>`
          }
          <form method="POST" action="/suscripcion/${slug}/registrar?key=${req.query.key}">
            <script
              src="https://checkout.wompi.co/widget.js"
              data-render="button"
              data-widget-operation="tokenize"
              data-public-key="${process.env.WOMPI_PUBLIC_KEY}">
            </script>
          </form>
        </div>
      </body>
    </html>
  `);
});

// Recibe el token de la tarjeta (nunca el número en sí) y crea una "fuente de
// pago" (payment source) en Wompi: un identificador reutilizable para cobrar
// esa tarjeta después, sin volver a pedirle los datos al dueño del negocio.
app.post("/suscripcion/:slug/registrar", async (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!negocio.claveAcceso || req.query.key !== negocio.claveAcceso) {
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

    res.redirect(`/suscripcion/${slug}?key=${req.query.key}`);
  } catch (err) {
    console.error("[suscripción] Error registrando tarjeta:", err.message);
    res.status(500).send("Ocurrió un error guardando la tarjeta. Intenta de nuevo.");
  }
});

// Cobra automáticamente la mensualidad a TODOS los negocios Pro cuya fecha de
// próximo cobro ya llegó. Visítala con un cron diario o mensual (igual que
// /notificar/:slug) — solo cobra a quien realmente le toque ese día:
// https://tu-dominio.com/cobrar-suscripciones?key=TU_CLAVE
app.get("/cobrar-suscripciones", async (req, res) => {
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

    const referencia = `tapin-sub-${slug}-${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, "0")}`;
    const montoCentavos = PRECIO_PRO_COP * 100;
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
        resultado.push({ slug, estado });
      } else {
        // No reintentamos solos ni desactivamos el plan automáticamente —
        // solo avisamos, para que decidas manualmente si le das un plazo o no.
        guardarCambiosNegocio(slug, negocio, {
          suscripcion: { ...sus, ultimoCobro: new Date().toISOString(), ultimoError: estado },
        });
        resultado.push({ slug, estado: `FALLÓ (${estado})` });
        await enviarEmail(
          negocio.email,
          "No pudimos procesar tu suscripción Pro de Tapin",
          `<p>Intentamos cobrar tu mensualidad del Plan Pro y la tarjeta registrada fue rechazada (estado: ${estado}).</p>
           <p>Por favor registra una tarjeta válida aquí: ${req.protocol}://${req.get("host")}/suscripcion/${slug}?key=${negocio.claveAcceso}</p>`
        );
      }
    } catch (err) {
      console.error(`[cobrar-suscripciones] Error con ${slug}:`, err.message);
      resultado.push({ slug, estado: "ERROR_SERVIDOR" });
    }
  }

  res.json({ ok: true, procesados: resultado.length, detalle: resultado });
});

app.listen(PORT, () => {
  console.log(`Tapin backend corriendo en el puerto ${PORT}`);
});
