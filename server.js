// server.js
// Backend de Tapin: cuenta y registra cada toque NFC/QR con fecha y hora exactas,
// redirige al cliente a Google, y permite exportar el historial por negocio
// (útil para cobrar la suscripción a tus clientes con datos reales).

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

// Clave simple para proteger /stats, /historial y /export (cámbiala por la tuya)
const ADMIN_KEY = process.env.ADMIN_KEY || "cambia-esta-clave";

// Zona horaria de Colombia para mostrar fecha/hora legibles
const TIMEZONE = "America/Bogota";

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
    claveAcceso: "mi-negocio-2026",
  },
  // "otro-local": {
  //   nombre: "Otro Local",
  //   googleUrl: "https://g.page/r/OTRO_ENLACE/review",
  //   categoria: "peluqueria",
  //   claveAcceso: "otro-local-2026",
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
  if (NEGOCIOS[slug]) return NEGOCIOS[slug];
  const codigos = leerCodigos();
  const entrada = codigos[slug];
  if (entrada && entrada.activado && entrada.negocio) return entrada.negocio;
  return null;
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

function registrarToque(slug, req) {
  const datos = leerDatos();
  if (!datos[slug]) {
    datos[slug] = { total: 0, eventos: [] };
  }

  const ahora = new Date();

  const evento = {
    fechaISO: ahora.toISOString(), // fecha exacta en formato estándar (para guardar/exportar)
    fechaLegible: ahora.toLocaleString("es-CO", { timeZone: TIMEZONE }), // ej: 27/6/2026, 9:14:32 a. m.
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

function guardarQueja(slug, comentario) {
  const datos = leerDatos();
  if (!datos[slug]) datos[slug] = { total: 0, eventos: [] };
  if (!datos[slug].quejas) datos[slug].quejas = [];
  const ahora = new Date();
  datos[slug].quejas.push({
    fechaISO: ahora.toISOString(),
    fechaLegible: ahora.toLocaleString("es-CO", { timeZone: TIMEZONE }),
    comentario,
  });
  guardarDatos(datos);
}

// Genera recomendaciones automáticas simples (reglas si-entonces) a partir de los
// datos ya calculados — esto es lo que convierte "te muestro números" en
// "te doy un consejo basado en tus números" (punto 8).
function generarRecomendaciones(eventos, r) {
  const recos = [];

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

  // Regla 3: hora/día pico de la semana
  const conteoPorDiaHora = {};
  for (const e of eventos) {
    const f = new Date(e.fechaISO);
    const dia = f.toLocaleDateString("es-CO", { timeZone: TIMEZONE, weekday: "long" });
    const hora = f.getHours();
    const bloque = hora < 12 ? "en la mañana" : hora < 18 ? "en la tarde" : "en la noche";
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
    if (codigos[codigo].activado && codigos[codigo].negocio) {
      dinamicos[codigo] = codigos[codigo].negocio;
    }
  }
  return { ...NEGOCIOS, ...dinamicos };
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

  registrarToque(slug, req);

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
    return res.redirect(302, negocio.googleUrl);
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
            <button type="submit">Enviar</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

app.post("/calificar/:slug", (req, res) => {
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");

  guardarQueja(slug, req.body.comentario || "(sin comentario)");

  res.send(`
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font-family:-apple-system,sans-serif;background:#F8F4EC;display:flex;align-items:center;
    justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;color:#16201C;}
    .box{background:#fff;border-radius:18px;padding:36px 28px;max-width:380px;box-shadow:0 10px 30px rgba(0,0,0,0.08);}
    </style></head>
    <body><div class="box"><h2>Gracias por avisarnos 🙏</h2><p>El negocio ya recibió tu comentario y lo va a revisar.</p></div></body></html>
  `);
});

// Panel visual: una tarjeta por negocio con totales de hoy, semana, y mini gráfica.
// Visítalo así: https://tu-dominio.com/stats?key=TU_CLAVE
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

              <label>Categoría</label>
              <select name="categoria">
                <option value="restaurante">Restaurante</option>
                <option value="peluqueria">Peluquería / Barbería</option>
                <option value="tienda">Tienda</option>
                <option value="clinica">Clínica / Consultorio</option>
                <option value="otro">Otro</option>
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

  const { nombre, googleUrl, categoria } = req.body;
  if (!nombre || !googleUrl) {
    return res.status(400).send("Faltan datos: nombre y enlace de Google son obligatorios.");
  }

  entrada.activado = true;
  entrada.activadoEl = new Date().toISOString();
  entrada.negocio = {
    nombre,
    googleUrl,
    categoria: categoria || "otro",
    claveAcceso: `${codigo.toLowerCase()}-panel`,
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

  let tarjetas = "";
  for (const slug in NEGOCIOS_TOTAL) {
    const eventos = (datos[slug] && datos[slug].eventos) || [];
    const r = calcularResumen(eventos);
    const ultimoTexto = r.ultimo ? r.ultimo.fechaLegible : "Sin toques todavía";
    const promSector = promedioSector(NEGOCIOS_TOTAL[slug].categoria, slug, datos);
    const sectorBadge = promSector !== null
      ? `<div class="sector-badge" style="color:${r.semana - promSector >= 0 ? MARCA.verde : MARCA.rojo}">
           ${r.semana - promSector >= 0 ? "▲" : "▼"} ${r.semana - promSector >= 0 ? "+" : ""}${r.semana - promSector} vs. promedio del sector
         </div>`
      : "";

    tarjetas += `
      <div class="card">
        <div class="card-top">
          <div>
            <div class="card-nombre">${NEGOCIOS_TOTAL[slug].nombre}</div>
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
        </div>
      </div>`;
  }

  if (!tarjetas) {
    tarjetas = `<p style="color:${MARCA.textoSuave}">No hay negocios configurados todavía en NEGOCIOS dentro de server.js.</p>`;
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
          .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;}
          .card{background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 2px rgba(11,61,44,0.04), 0 8px 24px rgba(11,61,44,0.06);border:1px solid ${MARCA.borde};transition:box-shadow .2s;}
          .card:hover{box-shadow:0 1px 2px rgba(11,61,44,0.05), 0 12px 32px rgba(11,61,44,0.10);}
          .card-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px;}
          .card-nombre{font-weight:700;font-size:1.08rem;letter-spacing:-0.01em;}
          .card-slug{font-size:0.76rem;color:${MARCA.textoSuave};margin-top:2px;font-family:monospace;}
          .card-total{text-align:right;font-size:1.7rem;font-weight:700;color:${MARCA.verde};line-height:1;}
          .card-total span{display:block;font-size:0.6rem;font-weight:600;color:${MARCA.textoSuave};margin-top:4px;letter-spacing:0.04em;text-transform:uppercase;}
          .card-metrics{display:flex;gap:12px;margin-bottom:18px;}
          .metric{background:${MARCA.verdeClaro};border-radius:12px;padding:12px 14px;flex:1;text-align:center;}
          .metric-num{font-size:1.3rem;font-weight:700;color:${MARCA.verdeOscuro};}
          .metric-lbl{font-size:0.68rem;color:${MARCA.verde};margin-top:2px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;}
          .sparkline{display:flex;align-items:flex-end;gap:5px;height:64px;margin-bottom:10px;}
          .sector-badge{font-size:0.74rem;font-weight:700;margin-bottom:14px;}
          .card-ultimo{font-size:0.82rem;color:${MARCA.textoSuave};margin-bottom:16px;padding-top:14px;border-top:1px solid ${MARCA.borde};}
          .card-ultimo b{color:${MARCA.texto};}
          .card-actions{display:flex;flex-wrap:wrap;}
          .card-actions a{color:${MARCA.verde};font-weight:600;text-decoration:none;font-size:0.78rem;white-space:nowrap;margin:0 14px 6px 0;}
          .card-actions a:hover{color:${MARCA.verdeOscuro};text-decoration:underline;}
        </style>
      </head>
      <body>
        <div class="topbar">
          <div style="display:flex;align-items:center;gap:0;">${logoSvg("#FFFFFF", 22)}</div>
          <a href="/codigos?key=${key}" style="color:#CFE3D8;font-size:0.78rem;font-weight:600;text-decoration:none;">+ Generar tarjetas</a>
        </div>
        <div class="content">
          <div class="eyebrow">Tiempo real</div>
          <h1 class="titulo-pagina">Resumen de negocios</h1>
          <div class="subtitulo">Actividad de toques por cada tarjeta Tapin activa.</div>
          <div class="grid">
            ${tarjetas}
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

  const filas = quejas
    .slice()
    .reverse()
    .map((q) => `<tr><td>${q.fechaLegible}</td><td>${q.comentario}</td></tr>`)
    .join("");

  res.send(`
    <html><head><meta charset="utf-8"><title>Quejas — ${negocio.nombre}</title>
    <style>
      body{font-family:sans-serif;background:#F8F4EC;padding:40px;color:#16201C;}
      table{border-collapse:collapse;width:100%;max-width:700px;background:#fff;border-radius:10px;overflow:hidden;}
      th,td{padding:10px 16px;text-align:left;border-bottom:1px solid #eee;font-size:0.9rem;}
      th{background:#16201C;color:#F8F4EC;}
      a{color:#1F6E4E;font-weight:600;}
    </style></head>
    <body>
      <p><a href="/stats?key=${req.query.key}">&larr; Volver al panel</a></p>
      <h1>Quejas privadas — ${negocio.nombre}</h1>
      <table><tr><th>Fecha</th><th>Comentario</th></tr>
      ${filas || "<tr><td colspan='2'>Sin quejas registradas</td></tr>"}
      </table>
    </body></html>
  `);
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
  const recomendaciones = generarRecomendaciones(eventos, r);

  const recomendacionesHtml = recomendaciones
    .map((texto) => `<div class="reco">💡 ${texto}</div>`)
    .join("");

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Mi Panel — ${negocio.nombre}</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#F8F4EC;padding:28px 20px;color:#16201C;margin:0;}
          .topbar{display:flex;align-items:center;gap:10px;margin-bottom:18px;}
          .logo-dot{width:9px;height:9px;border-radius:50%;background:#D6483B;box-shadow:14px 0 0 #E8A93D, 28px 0 0 #1F6E4E;margin-right:16px;}
          .logo-text{font-size:1.2rem;font-weight:700;color:#16201C;}
          .card{background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 10px rgba(0,0,0,0.05);
                border:1px solid #eee;max-width:520px;}
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
        </style>
      </head>
      <body>
        <div class="topbar"><span class="logo-dot"></span><span class="logo-text">Tapin</span></div>
        <div class="card">
          <h1>${negocio.nombre}</h1>
          <div class="fecha">Actualizado al ${new Date().toLocaleDateString("es-CO", { timeZone: TIMEZONE })}</div>
          <div class="metrics">
            <div class="metric"><div class="metric-num">${r.total}</div><div class="metric-lbl">Total</div></div>
            <div class="metric"><div class="metric-num">${r.hoy}</div><div class="metric-lbl">Hoy</div></div>
            <div class="metric"><div class="metric-num">${r.semana}</div><div class="metric-lbl">Últimos 7 días</div></div>
          </div>
          <div class="sparkline">${barraSemana(r.dias7)}</div>
          <div style="font-size:0.85rem;color:#666;margin-bottom:18px;">Último toque: <b>${ultimoTexto}</b></div>
          <h3 style="font-size:0.95rem;margin-bottom:10px;">Recomendaciones para ti</h3>
          ${recomendacionesHtml}
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
  const recomendaciones = generarRecomendaciones(eventos, r);
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
          <div class="fecha">Reporte generado el ${new Date().toLocaleDateString("es-CO", { timeZone: TIMEZONE })}</div>
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
  page.drawText(`Generado el ${new Date().toLocaleDateString("es-CO", { timeZone: TIMEZONE })}`, {
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

// Envía el resumen semanal de un negocio por WhatsApp usando CallMeBot (gratis).
// Esto NO se dispara solo — necesitas un servicio externo gratuito (cron-job.org)
// que visite esta URL una vez por semana. Ver instrucciones en el README.
// Visítalo así: https://tu-dominio.com/notificar/mi-negocio?key=TU_CLAVE
app.get("/notificar/:slug", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const { slug } = req.params;
  const negocio = obtenerNegocio(slug);
  if (!negocio) return res.status(404).send("Negocio no encontrado.");
  if (!negocio.whatsapp || !negocio.callmebotApiKey) {
    return res.status(400).send(
      "Este negocio no tiene configurado 'whatsapp' y 'callmebotApiKey' en NEGOCIOS dentro de server.js."
    );
  }

  const datos = leerDatos();
  const eventos = (datos[slug] && datos[slug].eventos) || [];
  const r = calcularResumen(eventos);

  const mensaje =
    `Resumen semanal de Tapin - ${negocio.nombre}\n` +
    `Toques esta semana: ${r.semana}\n` +
    `Toques hoy: ${r.hoy}\n` +
    `Total acumulado: ${r.total}`;

  const url = `https://api.callmebot.com/whatsapp.php?phone=${negocio.whatsapp}&text=${encodeURIComponent(mensaje)}&apikey=${negocio.callmebotApiKey}`;

  try {
    const resp = await fetch(url);
    const texto = await resp.text();
    res.send(`Notificación enviada. Respuesta de CallMeBot: ${texto}`);
  } catch (err) {
    res.status(500).send("Error enviando el mensaje: " + err.message);
  }
});

// Misma información en JSON, útil si luego quieres conectar esto a un dashboard propio.
app.get("/stats.json", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ error: "No autorizado" });
  }
  const datos = leerDatos();
  res.json(datos);
});

app.get("/", (req, res) => {
  res.send("Servidor de Tapin activo. Usa /r/:slug para los QR/NFC y /stats?key=... para ver el conteo.");
});

app.listen(PORT, () => {
  console.log(`Tapin backend corriendo en el puerto ${PORT}`);
});
