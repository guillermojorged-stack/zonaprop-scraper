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

// ---- Selectores (único bloque a tocar si cambia el diseño) ----
const SELECTORS = {
  cardList: 'div[data-posting-type], div.postingCard, div[data-qa="posting PROPERTY"]',
  cardLink: 'a[data-to-posting], a.go-to-posting, a[href*="-"][href$=".html"]',
  title: 'h1, [data-qa="POSTING_CARD_DESCRIPTION"]',
  price: '[data-qa="POSTING_CARD_PRICE"], .price-items, .price-tag, [data-qa="PRICE"]',
  expenses: '[data-qa="expensas"], [data-qa="EXPENSAS"], .expenses',
  location: '[data-qa="POSTING_CARD_LOCATION"], [data-qa="LOCATION"], .postingLocation',
  description: '[data-qa="POSTING_CARD_DESCRIPTION"], #longDescription, .article-section-description, [data-qa="DESCRIPTION"]',
  features: 'span.postingMainFeatures, [data-qa="POSTING_CARD_FEATURES"] span, [data-qa="MAIN_FEATURES"] span',
  contact: '[data-qa="cardOwnerName"], .PublisherName, .company-info a, [data-qa="PUBLISHER_NAME"]',
  phone: '[data-qa="POSTING_CARD_PHONE"], a[href^="tel:"]',
  photos: 'img[data-flkty-lazyload], .gallery img, picture img',
};

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

function debugSelectores($) {
  const dataQaEls = [...new Set($('[data-qa]').map((_, el) => $(el).attr('data-qa')).get())];
  const priceLike = [];
  $('*').each((_, el) => {
    const $el = $(el);
    if ($el.children().length === 0) {
      const t = $el.text().trim();
      if (/(\$|USD|U\$S)\s?[\d.,]+/.test(t)) {
        priceLike.push({ tag: el.tagName, class: $el.attr('class'), dataQa: $el.attr('data-qa'), text: t });
      }
    }
  });
  const imgs = $('img');
  const imgSamples = imgs.slice(0, 5).map((_, img) => ({
    src: $(img).attr('src'),
    dataSrc: $(img).attr('data-src') || $(img).attr('data-flkty-lazyload'),
    class: $(img).attr('class'),
  })).get();
  console.log('DEBUG_SELECTORS:', JSON.stringify({ dataQaEls, priceLike: priceLike.slice(0, 8), imgCount: imgs.length, imgSamples }, null, 2));
}

async function scrapeFicha(url) {
  const html = await obtenerHtml(url);
  const $ = cheerio.load(html);

  if (process.env.DEBUG_SELECTORS) debugSelectores($);

  const text = (sel) => $(sel).first().text().trim();
  const fotos = [];
  $(SELECTORS.photos).each((_, img) => {
    const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-flkty-lazyload');
    if (src && !src.includes('data:image') && !fotos.includes(src)) fotos.push(src);
  });

  const features = $(SELECTORS.features).map((_, s) => $(s).text().trim()).get();

  const data = {
    titulo: text(SELECTORS.title),
    precioTexto: text(SELECTORS.price),
    expensasTexto: text(SELECTORS.expenses),
    ubicacion: text(SELECTORS.location),
    descripcion: text(SELECTORS.description),
    inmobiliaria: text(SELECTORS.contact),
    telefono: ($(SELECTORS.phone).first().attr('href') || '').replace('tel:', ''),
    features,
    fotos: fotos.slice(0, 20),
  };

  const { precio, moneda } = parsePrecio(data.precioTexto);
  const expensas = data.expensasTexto ? Number(data.expensasTexto.replace(/[^\d]/g, '')) || null : null;

  const m2 = data.features.find((f) => /m²/.test(f));
  const ambientes = data.features.find((f) => /amb\./i.test(f));
  const dormitorios = data.features.find((f) => /dorm/i.test(f));
  const banos = data.features.find((f) => /baño/i.test(f));

  return {
    zonaprop_id: extraerIdDeUrl(url),
    url,
    titulo: data.titulo,
    descripcion: data.descripcion,
    precio,
    moneda,
    expensas,
    ubicacion: data.ubicacion,
    m2_totales: m2 ? Number(m2.replace(/[^\d]/g, '')) || null : null,
    ambientes: ambientes ? Number(ambientes.replace(/[^\d]/g, '')) || null : null,
    dormitorios: dormitorios ? Number(dormitorios.replace(/[^\d]/g, '')) || null : null,
    banos: banos ? Number(banos.replace(/[^\d]/g, '')) || null : null,
    inmobiliaria: data.inmobiliaria,
    telefono_contacto: data.telefono,
    fotos: data.fotos,
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
