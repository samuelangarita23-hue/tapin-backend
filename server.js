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
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

// ---------- Envío de correos (alertas, reportes mensuales, etc.) ----------
// Funciona con cualquier SMTP. Para Gmail: activa verificación en 2 pasos en la
// cuenta y genera una "contraseña de aplicación" (myaccount.google.com/apppasswords),
// esa es la que va en EMAIL_PASS (NO tu contraseña normal de Gmail).
// Variables de entorno necesarias en Render: EMAIL_USER, EMAIL_PASS.
let transportadorEmail = null;
function obtenerTransportador() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return null;
  if (!transportadorEmail) {
    transportadorEmail = nodemailer.createTransport({
      host: process.env.EMAIL_HOST || "smtp.gmail.com",
      port: parseInt(process.env.EMAIL_PORT, 10) || 465,
      secure: true,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
  }
  return transportadorEmail;
}

async function enviarEmail(destinatario, asunto, html) {
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
    });
    return { ok: true };
  } catch (err) {
    console.error("Error enviando email:", err.message);
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

function logoSvg(color, height) {
  return `<svg viewBox="-40 -780 2913 880" style="height:${height}px;display:block;"><path d="${LOGO_PATH}" fill="${color}"/></svg>`;
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
  },
  // "otro-local": {
  //   nombre: "Otro Local",
  //   googleUrl: "https://g.page/r/OTRO_ENLACE/review",
  //   categoria: "peluqueria",
  //   claveAcceso: "otro-local-2026",
  //   email: "dueno@otrolocal.com",
  //   plan: "pro",
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

const CODIGOS_FILE = path.join(__dirname, "codigos.json");

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

// Las 3 funciones de valor agregado (alerta instantánea de quejas, reporte mensual
// por correo, y generador de contenido) están reservadas al Plan Pro.
// Si el negocio no tiene plan "pro", simplemente no se disparan — sin importar
// si el código las soporta técnicamente.
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
  const { nombre, googleUrl, categoria, pais, email, plan } = req.body;
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
  const { nombre, googleUrl, categoria, pais, email, plan } = req.body;
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
                <option value="basico" ${valores.plan !== "pro" ? "selected" : ""}>Básico ($89.900 — sin alertas ni reportes)</option>
                <option value="pro" ${valores.plan === "pro" ? "selected" : ""}>Pro ($180.000/mes — alertas, reporte mensual, contenido)</option>
              </select>

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
        <title>Activar tarjeta — Tapin</title>
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
        </style>
      </head>
      <body>
        <div class="topbar"><div>${logoSvg("#FFFFFF", 22)}</div></div>
        <div class="content">
          <div class="eyebrow">Código ${codigo}</div>
          <h1 class="titulo-pagina">Activar esta tarjeta</h1>
          <div class="subtitulo">Completa los datos del negocio para dejar la tarjeta lista para usar.</div>

          <div class="form-card">
            <form method="POST" action="/activar/${codigo}">
              <label>Nombre del negocio</label>
              <input type="text" name="nombre" required placeholder="Ej: Restaurante La 21">

              <label>Enlace de reseñas de Google</label>
              <input type="url" name="googleUrl" required placeholder="https://g.page/r/.../review">

              <label>Email del negocio (alertas y reportes llegan aquí)</label>
              <input type="email" name="email" required placeholder="dueno@negocio.com">

              <label>Plan</label>
              <select name="plan">
                <option value="basico">Básico ($89.900 — sin alertas ni reportes)</option>
                <option value="pro">Pro ($180.000/mes — alertas, reporte mensual, contenido)</option>
              </select>

              <label>Categoría</label>
              <select name="categoria">
                <option value="restaurante">Restaurante</option>
                <option value="peluqueria">Peluquería / Barbería</option>
                <option value="tienda">Tienda</option>
                <option value="clinica">Clínica / Consultorio</option>
                <option value="otro">Otro</option>
              </select>

              <label>País (define la hora local de los reportes)</label>
              <select name="pais">
                <option value="colombia">Colombia</option>
                <option value="panama">Panamá</option>
                <option value="paraguay">Paraguay</option>
                <option value="miami">Estados Unidos (Miami)</option>
              </select>

              <button type="submit">Activar tarjeta</button>
            </form>
          </div>
        </div>
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

  const { nombre, googleUrl, categoria, pais, email, plan } = req.body;
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
          <a href="/quejas/${slug}?key=${key}">Quejas</a>
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
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quejas — ${negocio.nombre}</title>
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
        <h1 class="titulo-pagina">Quejas privadas — ${negocio.nombre}</h1>
        <div class="subtitulo">Cada reseña negativa se queda aquí en vez de publicarse. El dueño recibe un correo al instante para poder reaccionar.</div>
        <div class="metrics">
          <div class="metric"><div class="metric-num">${quejas.length}</div><div class="metric-lbl">Total quejas</div></div>
          <div class="metric"><div class="metric-num">${resueltas}</div><div class="metric-lbl">Resueltas</div></div>
          <div class="metric"><div class="metric-num">${tasaRecuperacion}%</div><div class="metric-lbl">Tasa de recuperación</div></div>
        </div>
        <table><tr><th>Fecha</th><th>Comentario</th><th>Teléfono</th><th>Estado</th><th>Acción</th></tr>
        ${filas || "<tr><td colspan='5'>Sin quejas registradas</td></tr>"}
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

// Reporte mensual en PDF, con diseño simple de marca — para entregar al cliente
// en vez de un CSV plano (punto 7).
// Visítalo así: https://tu-dominio.com/export/mi-negocio.pdf?key=TU_CLAVE
app.get("/export/:slug.pdf", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

  const datos = leerDatos();
  const eventos = (datos[slug] && datos[slug].eventos) || [];
  const r = calcularResumen(eventos);

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const verde = rgb(0.12, 0.43, 0.31);
  const oscuro = rgb(0.09, 0.13, 0.11);
  const gris = rgb(0.5, 0.5, 0.5);

  let y = 790;
  page.drawText("Reporte Tapin", { x: 50, y, size: 22, font: fontBold, color: oscuro });
  y -= 26;
  page.drawText(negocio.nombre, { x: 50, y, size: 14, font, color: verde });
  y -= 18;
  page.drawText(`Generado el ${new Date().toLocaleDateString("es-CO", { timeZone: zonaDe(negocio) })}`, {
    x: 50, y, size: 10, font, color: gris,
  });

  y -= 50;
  const metrics = [
    ["Toques totales", r.total],
    ["Toques hoy", r.hoy],
    ["Últimos 7 días", r.semana],
  ];
  let x = 50;
  metrics.forEach(([label, val]) => {
    page.drawRectangle({ x, y: y - 50, width: 150, height: 60, color: rgb(0.97, 0.96, 0.93) });
    page.drawText(String(val), { x: x + 14, y: y - 18, size: 22, font: fontBold, color: verde });
    page.drawText(label, { x: x + 14, y: y - 40, size: 9, font, color: gris });
    x += 165;
  });

  y -= 90;
  page.drawText("Toques por día (últimos 7 días)", { x: 50, y, size: 12, font: fontBold, color: oscuro });
  y -= 20;

  const max = Math.max(1, ...r.dias7);
  const nombresDias = [];
  const ahora = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(ahora);
    d.setDate(d.getDate() - i);
    nombresDias.push(d.toLocaleDateString("es-CO", { weekday: "short" }));
  }
  const barAreaTop = y;
  const barAreaHeight = 90;
  r.dias7.forEach((v, i) => {
    const barHeight = (v / max) * barAreaHeight;
    const bx = 50 + i * 70;
    page.drawRectangle({
      x: bx, y: barAreaTop - barAreaHeight, width: 36, height: barHeight || 1,
      color: verde,
    });
    page.drawText(String(v), { x: bx + 12, y: barAreaTop - barAreaHeight - 14, size: 9, font, color: gris });
    page.drawText(nombresDias[i], { x: bx, y: barAreaTop - barAreaHeight - 28, size: 9, font, color: oscuro });
  });

  y = barAreaTop - barAreaHeight - 60;
  page.drawText("Ultimas interacciones", { x: 50, y, size: 12, font: fontBold, color: oscuro });
  y -= 18;

  const recientes = eventos.slice(-12).reverse();
  recientes.forEach((e) => {
    if (y < 60) return;
    page.drawText(`${e.fechaLegible}  -  ${e.dispositivo}`, { x: 50, y, size: 9, font, color: gris });
    y -= 14;
  });

  const pdfBytes = await pdfDoc.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="reporte-tapin-${slug}.pdf"`);
  res.send(Buffer.from(pdfBytes));
});

// Exporta el historial completo de un negocio como archivo CSV.
// Ideal para entregarle el reporte a tu cliente (Excel/Google Sheets lo abre directo).
// Visítalo así: https://tu-dominio.com/export/mi-negocio.csv?key=TU_CLAVE
app.get("/export/:slug.csv", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }

  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

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

  const filasBarra = barraSemana(r.dias7);
  const recosHtml = recomendaciones
    .map((texto) => `<div style="background:#F1F7F4;border-left:3px solid ${MARCA.verde};border-radius:8px;padding:12px 14px;font-size:0.88rem;margin-bottom:8px;color:#1F3D2E;">💡 ${texto}</div>`)
    .join("");

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
        <h3 style="font-size:0.95rem;margin:20px 0 8px;">Recomendaciones</h3>
        ${recosHtml}
        <p style="font-size:0.78rem;color:#999;margin-top:24px;">Ver panel completo: ${req.protocol}://${req.get("host")}/mi-panel/${slug}?key=${negocio.claveAcceso || ""}</p>
      </div>
    `
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

app.get("/", (req, res) => {
  res.send("Servidor de Tapin activo. Usa /r/:slug para los QR/NFC y /stats?key=... para ver el conteo.");
});

app.listen(PORT, () => {
  console.log(`Tapin backend corriendo en el puerto ${PORT}`);
});
