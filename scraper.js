/**
 * Zonaprop Scraper
 * ScraperAPI (evita bloqueos anti-bot) + Cheerio (parseo de HTML) + Supabase
 *
 * USO:
 *   node scraper.js "https://www.zonaprop.com.ar/propiedades/clasificado/...-59667489.html"
 *
 * Requiere .env con:
 *   SUPABASE_URL=
 *   SUPABASE_SERVICE_ROLE_KEY=
 *   SCRAPERAPI_KEY=
 *
 * MANTENIMIENTO: los selectores CSS están centralizados en SELECTORS.
 * Si Zonaprop cambia el HTML, actualizar solo ese bloque.
 */

require('dotenv').config();
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}
if (!SCRAPERAPI_KEY) {
  console.error('Falta SCRAPERAPI_KEY en .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- Selectores para el modo listado (búsqueda de URLs de propiedades) ----
const SELECTORS = {
  cardLink: 'a[data-to-posting], a.go-to-posting, a[href*="-"][href$=".html"]',
};

// La ficha de Zonaprop trae un bloque `const avisoInfo = {...}` embebido en el HTML
// con todos los datos estructurados (precio, m², ambientes, fotos, teléfono, etc).
// Es mucho más estable que scrapear clases CSS, que cambian seguido.
// MANTENIMIENTO: si Zonaprop deja de incluir `avisoInfo`, ahí es donde hay que mirar.
function extraerCampoJs(html, key) {
  const marker = `'${key}':`;
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  let i = idx + marker.length;
  while (/\s/.test(html[i])) i++;
  const openChar = html[i];
  if (openChar === '{' || openChar === '[') {
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    const start = i;
    for (; i < html.length; i++) {
      if (html[i] === openChar) depth++;
      else if (html[i] === closeChar) {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    try {
      return JSON.parse(html.slice(start, i));
    } catch {
      return null;
    }
  }
  if (openChar === "'" || openChar === '"') {
    const quote = openChar;
    const start = i + 1;
    let j = start;
    while (j < html.length) {
      if (html[j] === '\\') { j += 2; continue; }
      if (html[j] === quote) break;
      j++;
    }
    return html.slice(start, j);
  }
  let j = i;
  while (j < html.length && !/[,\n]/.test(html[j])) j++;
  return html.slice(i, j).trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function obtenerHtml(url) {
  const apiUrl = `https://api.scraperapi.com/?api_key=${SCRAPERAPI_KEY}&url=${encodeURIComponent(url)}&render=true&country_code=ar`;
  const res = await fetch(apiUrl);
  if (!res.ok) {
    throw new Error(`ScraperAPI respondió ${res.status}: ${await res.text()}`);
  }
  return res.text();
}

function parsePrecio(text = '') {
  const moneda = text.includes('U$S') || text.includes('USD') ? 'USD' : 'ARS';
  const num = text.replace(/[^\d]/g, '');
  return { precio: num ? Number(num) : null, moneda };
}

function extraerIdDeUrl(url) {
  const match = url.match(/(\d{6,})/);
  return match ? match[1] : url.split('/').pop().replace('.html', '');
}

async function scrapeListado(urlBusqueda) {
  const html = await obtenerHtml(urlBusqueda);
  const $ = cheerio.load(html);
  const urls = new Set();
  $(SELECTORS.cardLink).each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('.html')) {
      urls.add(href.startsWith('http') ? href : `https://www.zonaprop.com.ar${href}`);
    }
  });
  return [...urls];
}

async function scrapeFicha(url) {
  const html = await obtenerHtml(url);

  const idAviso = extraerCampoJs(html, 'idAviso') || extraerIdDeUrl(url);
  const precioTexto = extraerCampoJs(html, 'price') || '';
  const expensasTexto = extraerCampoJs(html, 'expenses') || '';
  const descripcionHtml = extraerCampoJs(html, 'description') || '';
  const location = extraerCampoJs(html, 'location');
  const mainFeatures = extraerCampoJs(html, 'mainFeatures') || {};
  const publisher = extraerCampoJs(html, 'publisher');
  const whatsApp = extraerCampoJs(html, 'whatsApp');
  const pictures = extraerCampoJs(html, 'pictures') || [];
  const postingTitle = extraerCampoJs(html, 'postingTitle') || extraerCampoJs(html, 'generatedTitle');

  const { precio, moneda } = parsePrecio(precioTexto);
  const expensas = expensasTexto ? Number(String(expensasTexto).replace(/[^\d]/g, '')) || null : null;

  const ubicacion = location ? [location.name, location.parent?.name].filter(Boolean).join(', ') : null;
  const descripcion = descripcionHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

  const numFeature = (id) => {
    const v = mainFeatures[id]?.value;
    if (!v) return null;
    const n = Number(String(v).replace(/[^\d]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const fotos = pictures
    .map((p) => p.url1200x1200 || p.url730x532 || p.url360x266)
    .filter(Boolean)
    .slice(0, 20);

  return {
    zonaprop_id: String(idAviso),
    url,
    titulo: postingTitle,
    descripcion,
    precio,
    moneda,
    expensas,
    ubicacion,
    m2_totales: numFeature('CFT100'),
    ambientes: numFeature('CFT1'),
    dormitorios: numFeature('CFT2'),
    banos: numFeature('CFT3'),
    inmobiliaria: publisher?.name || null,
    telefono_contacto: whatsApp || null,
    fotos,
    ultima_actualizacion: new Date().toISOString(),
  };
}

async function guardarEnSupabase(registro) {
  const { error } = await supabase
    .from('propiedades_zonaprop')
    .upsert(registro, { onConflict: 'zonaprop_id' });
  if (error) console.error(`  ✗ Error guardando ${registro.zonaprop_id}:`, error.message);
  else console.log(`  ✓ Guardado ${registro.zonaprop_id} - ${registro.titulo?.slice(0, 50)}`);
}

// Una URL de propiedad puntual tiene "-<numero>.html" al final (id de publicación).
function esUrlDeUnaPropiedad(url) {
  return /-\d{6,}\.html/.test(url);
}

async function main() {
  const urlEntrada = process.argv[2];
  if (!urlEntrada) {
    console.error('Uso: node scraper.js "<url-de-zonaprop>"');
    process.exit(1);
  }

  try {
    if (esUrlDeUnaPropiedad(urlEntrada)) {
      // Modo "una sola propiedad" (uso desde la web, on-demand)
      console.log(`Scrapeando propiedad puntual: ${urlEntrada}`);
      const registro = await scrapeFicha(urlEntrada);
      await guardarEnSupabase(registro);
    } else {
      // Modo "listado completo" (uso programado / cron)
      console.log(`Buscando publicaciones en: ${urlEntrada}`);
      const urls = await scrapeListado(urlEntrada);
      console.log(`Encontradas ${urls.length} publicaciones.`);

      for (const url of urls) {
        try {
          const registro = await scrapeFicha(url);
          await guardarEnSupabase(registro);
          await sleep(1000 + Math.random() * 1000);
        } catch (e) {
          console.error(`  ✗ Error en ${url}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('Error general:', e.message);
    process.exit(1);
  }
}

main();
