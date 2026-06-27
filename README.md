# Backend de Tapin — contador de toques

Este servidor hace dos cosas:

1. Recibe la visita cuando alguien toca el NFC o escanea el QR de la tarjeta Tapin.
2. Cuenta el toque y redirige automáticamente al cliente a tu página de reseñas de Google.

## Cómo funciona

En vez de programar el chip NFC o el QR directamente con tu enlace de Google, lo programas con la URL de este servidor:

```
https://tu-dominio.com/r/mi-negocio
```

Cuando alguien toca la tarjeta:
- El servidor suma 1 al contador de `mi-negocio`
- Inmediatamente redirige al cliente a tu enlace real de reseñas de Google
- El cliente no nota ninguna diferencia, todo pasa en menos de un segundo

## Configurar tus negocios

Abre `server.js` y edita el objeto `NEGOCIOS`:

```js
const NEGOCIOS = {
  "mi-negocio": {
    nombre: "Mi Negocio",
    googleUrl: "https://g.page/r/TU_ENLACE_REAL/review",
  },
};
```

- `mi-negocio` es el "slug": la parte de la URL que va en el QR/NFC. Puedes ponerle el nombre que quieras (sin espacios ni tildes).
- `googleUrl` es el enlace real a tu página de reseñas de Google (lo consigues desde tu perfil de Google Business, botón "Pedir reseñas").
- Si tienes varios locales, agrega uno por cada uno dentro del mismo objeto.

## Cómo correrlo localmente

```bash
npm install
npm start
```

El servidor queda corriendo en `http://localhost:3000`.

## Cómo ver cuántos toques lleva cada negocio

Visita en el navegador:

```
http://localhost:3000/stats?key=cambia-esta-clave
```

(Cambia `cambia-esta-clave` por el valor que pongas en la variable `ADMIN_KEY` dentro de `server.js`, o exporta la variable de entorno `ADMIN_KEY` antes de correr el servidor.)

Desde esa página también puedes hacer clic en "Ver historial" o "Descargar CSV" para cada negocio.

## Historial detallado por negocio (fecha y hora exacta de cada toque)

```
http://localhost:3000/historial/mi-negocio?key=cambia-esta-clave
```

Te muestra una tabla con cada toque registrado: número, fecha y hora exacta (zona horaria Colombia), y tipo de dispositivo (iPhone, Android, etc). Esto es lo que le puedes mostrar a tu cliente como evidencia del servicio que está pagando.

## Exportar el historial como CSV (para entregarle el reporte a tu cliente)

```
http://localhost:3000/export/mi-negocio.csv?key=cambia-esta-clave
```

Descarga un archivo `.csv` que se abre directo en Excel o Google Sheets, con todas las fechas y horas de cada toque. Ideal para mandárselo mensualmente a tu cliente y justificar la suscripción de Tapin con datos reales de uso.

También existe una versión en JSON de todos los negocios en `/stats.json?key=...` si más adelante quieres conectar esto a una gráfica o dashboard propio.

## Cómo ponerlo en internet (para que el QR funcione desde cualquier celular)

Necesitas que este servidor quede accesible por una URL pública. Opciones sencillas y gratis para empezar:

- **Render.com** (gratis para empezar): conectas tu repositorio de GitHub, eliges "Web Service", y Render detecta automáticamente que es Node.js.
- **Railway.app**: similar a Render, muy simple de usar.
- **Vercel** (necesita un pequeño ajuste para correr Express como función serverless).

Pasos generales:
1. Sube esta carpeta a un repositorio de GitHub.
2. Conecta el repositorio en Render o Railway.
3. Una vez desplegado, te dan una URL pública, por ejemplo `https://tapin-mi-negocio.onrender.com`.
4. Usa esa URL + `/r/mi-negocio` como el enlace que programas en el QR y en el chip NFC.

## Nota sobre el contador

Este backend guarda los datos en un archivo `data.json` en el propio servidor. Es perfecto para empezar y para uno o pocos negocios. Si más adelante quieres algo más robusto (muchos negocios, reportes, gráficas), se puede migrar fácilmente a una base de datos como PostgreSQL o a un servicio como Supabase, conservando la misma lógica de `/r/:slug`.
