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

// ---------- Configuración de negocios ----------
// Agrega aquí un negocio por cada Tapin que tengas en la calle.
// "slug" es lo que va en la URL del QR/NFC, ej: /r/mi-negocio
// "categoria" se usa para comparar el negocio contra otros del mismo tipo (punto 9).
const NEGOCIOS = {
  "mi-negocio": {
    nombre: "Mi Negocio",
    googleUrl: "https://g.page/r/REEMPLAZA_CON_TU_ENLACE/review",
    categoria: "restaurante",
  },
  // "otro-local": {
  //   nombre: "Otro Local",
  //   googleUrl: "https://g.page/r/OTRO_ENLACE/review",
  //   categoria: "peluqueria",
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
          <div style="width:100%;max-width:22px;height:${alturaPx}px;background:#1F6E4E;border-radius:4px 4px 0 0;"></div>
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

// Calcula el promedio de toques (últimos 7 días) de los negocios de la misma categoría,
// excluyendo al propio negocio. Sirve para el comparativo "vs. promedio del sector" (punto 9).
function promedioSector(categoria, slugActual, datos) {
  const pares = Object.entries(NEGOCIOS).filter(
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
  const negocio = NEGOCIOS[slug];

  if (!negocio) {
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
  const negocio = NEGOCIOS[slug];
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
  const negocio = NEGOCIOS[slug];
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
app.get("/stats", (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }

  const datos = leerDatos();
  const key = req.query.key;

  let tarjetas = "";
  for (const slug in NEGOCIOS) {
    const eventos = (datos[slug] && datos[slug].eventos) || [];
    const r = calcularResumen(eventos);
    const ultimoTexto = r.ultimo ? r.ultimo.fechaLegible : "Sin toques todavía";
    const promSector = promedioSector(NEGOCIOS[slug].categoria, slug, datos);
    let comparativoHtml = "";
    if (promSector !== null) {
      const diferencia = r.semana - promSector;
      const signo = diferencia > 0 ? "+" : "";
      const color = diferencia >= 0 ? "#1F6E4E" : "#D6483B";
      comparativoHtml = `<div class="card-ultimo">Promedio del sector (${NEGOCIOS[slug].categoria}): <b>${promSector}</b> toques/semana — tú estás <b style="color:${color}">${signo}${diferencia}</b></div>`;
    }

    tarjetas += `
      <div class="card">
        <div class="card-top">
          <div>
            <div class="card-nombre">${NEGOCIOS[slug].nombre}</div>
            <div class="card-slug">/r/${slug}</div>
          </div>
          <div class="card-total">${r.total}<span>toques totales</span></div>
        </div>

        <div class="card-metrics">
          <div class="metric"><div class="metric-num">${r.hoy}</div><div class="metric-lbl">Hoy</div></div>
          <div class="metric"><div class="metric-num">${r.semana}</div><div class="metric-lbl">Últimos 7 días</div></div>
        </div>

        <div class="sparkline">${barraSemana(r.dias7)}</div>

        <div class="card-ultimo">Último toque: <b>${ultimoTexto}</b></div>
        ${comparativoHtml}

        <div class="card-actions">
          <a href="/historial/${slug}?key=${key}">Ver historial completo</a>
          <a href="/export/${slug}.csv?key=${key}">Descargar CSV</a>
          <a href="/export/${slug}.pdf?key=${key}">Descargar PDF</a>
          <a href="/quejas/${slug}?key=${key}">Ver quejas</a>
        </div>
      </div>`;
  }

  if (!tarjetas) {
    tarjetas = `<p>No hay negocios configurados todavía en NEGOCIOS dentro de server.js.</p>`;
  }

  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Panel Tapin</title>
        <style>
          *{box-sizing:border-box;}
          body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#F8F4EC;padding:32px 24px;color:#16201C;margin:0;}
          h1{font-size:1.5rem;margin-bottom:4px;}
          .sub{color:#777;margin-bottom:28px;font-size:0.9rem;}
          .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;max-width:1100px;}
          .card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 10px rgba(0,0,0,0.05);border:1px solid #eee;}
          .card-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;}
          .card-nombre{font-weight:700;font-size:1.05rem;}
          .card-slug{font-size:0.78rem;color:#999;margin-top:2px;}
          .card-total{text-align:right;font-size:1.6rem;font-weight:700;color:#1F6E4E;line-height:1;}
          .card-total span{display:block;font-size:0.62rem;font-weight:500;color:#999;margin-top:2px;}
          .card-metrics{display:flex;gap:16px;margin-bottom:16px;}
          .metric{background:#F8F4EC;border-radius:10px;padding:10px 14px;flex:1;text-align:center;}
          .metric-num{font-size:1.25rem;font-weight:700;}
          .metric-lbl{font-size:0.7rem;color:#888;margin-top:2px;}
          .sparkline{display:flex;align-items:flex-end;gap:4px;height:80px;margin-bottom:14px;border-top:1px solid #f0f0f0;padding-top:8px;}
          .card-ultimo{font-size:0.82rem;color:#666;margin-bottom:14px;}
          .card-actions{display:flex;border-top:1px solid #f0f0f0;padding-top:12px;}
          .card-actions a{color:#1F6E4E;font-weight:600;text-decoration:none;font-size:0.85rem;margin-right:20px;}
          .card-actions a:hover{text-decoration:underline;}
        </style>
      </head>
      <body>
        <h1>Panel Tapin</h1>
        <div class="sub">Resumen de toques por negocio, en tiempo real.</div>
        <div class="grid">
          ${tarjetas}
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
  const negocio = NEGOCIOS[slug];
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
  const negocio = NEGOCIOS[slug];
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

// Reporte mensual en PDF, con diseño simple de marca — para entregar al cliente
// en vez de un CSV plano (punto 7).
// Visítalo así: https://tu-dominio.com/export/mi-negocio.pdf?key=TU_CLAVE
app.get("/export/:slug.pdf", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado. Agrega ?key=TU_CLAVE a la URL.");
  }
  const { slug } = req.params;
  const negocio = NEGOCIOS[slug];
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
  const negocio = NEGOCIOS[slug];
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
  const negocio = NEGOCIOS[slug];
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
