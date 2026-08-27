/**
 * Zonaprop Scraper
 * Node.js + Puppeteer (stealth) + Supabase
 *
 * USO:
 *   node scraper.js "https://www.zonaprop.com.ar/departamentos-alquiler-palermo.html"
 *
 * Requiere .env con:
 *   SUPABASE_URL=
 *   SUPABASE_SERVICE_ROLE_KEY=
 *
 * MANTENIMIENTO: los selectores CSS están centralizados en SELECTORS.
 * Si Zonaprop cambia el HTML, actualizar solo ese bloque.
 */

require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

puppeteer.use(StealthPlugin());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- Selectores (único bloque a tocar si cambia el diseño) ----
const SELECTORS = {
  cardList: 'div[data-posting-type], div.postingCard, div[data-qa="posting PROPERTY"]',
  cardLink: 'a[data-to-posting], a.go-to-posting, a[href*="-"][href$=".html"]',
  nextPage: 'a[data-qa="PAGING_NEXT"], a.paging-page-next',
  title: 'h1, [data-qa="POSTING_CARD_DESCRIPTION"]',
  price: '[data-qa="POSTING_CARD_PRICE"], .price-items, .price-tag',
  expenses: '[data-qa="expensas"], .expenses',
  location: '[data-qa="POSTING_CARD_LOCATION"], .postingLocation',
  description: '[data-qa="POSTING_CARD_DESCRIPTION"], #longDescription, .article-section-description',
  features: 'span.postingMainFeatures, [data-qa="POSTING_CARD_FEATURES"] span',
  contact: '[data-qa="cardOwnerName"], .PublisherName, .company-info a',
  phone: '[data-qa="POSTING_CARD_PHONE"], a[href^="tel:"]',
  photos: 'img[data-flkty-lazyload], .gallery img, picture img',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePrecio(text = '') {
  const moneda = text.includes('U$S') || text.includes('USD') ? 'USD' : 'ARS';
  const num = text.replace(/[^\d]/g, '');
  return { precio: num ? Number(num) : null, moneda };
}

function extraerIdDeUrl(url) {
  const match = url.match(/(\d{6,})/);
  return match ? match[1] : url.split('/').pop().replace('.html', '');
}

async function scrapeListado(page, urlBusqueda) {
  await page.goto(urlBusqueda, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector(SELECTORS.cardList, { timeout: 15000 }).catch(() => {});

  const urls = await page.$$eval(SELECTORS.cardLink, (links) =>
    [...new Set(links.map((a) => a.href).filter((h) => h.includes('.html')))]
  );
  return urls;
}

async function scrapeFicha(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1000);

  const data = await page.evaluate((SEL) => {
    const text = (sel) => document.querySelector(sel)?.innerText?.trim() || '';
    const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) || '';

    const fotos = [...document.querySelectorAll(SEL.photos)]
      .map((img) => img.src || img.getAttribute('data-src'))
      .filter(Boolean)
      .filter((src) => !src.includes('data:image'))
      .slice(0, 20);

    const features = [...document.querySelectorAll(SEL.features)].map((s) => s.innerText.trim());

    return {
      titulo: text(SEL.title),
      precioTexto: text(SEL.price),
      expensasTexto: text(SEL.expenses),
      ubicacion: text(SEL.location),
      descripcion: text(SEL.description),
      inmobiliaria: text(SEL.contact),
      telefono: attr(SEL.phone, 'href').replace('tel:', ''),
      features,
      fotos,
    };
  }, SELECTORS);

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

// Una URL de listado tiene "-<numero>.html" al final (id de publicación).
// Una URL de búsqueda no tiene ese patrón (termina en palabras, ej. "-palermo.html" sin ID numérico largo al final).
function esUrlDeUnaPropiedad(url) {
  return /-\d{6,}\.html/.test(url);
}

async function main() {
  const urlEntrada = process.argv[2];
  if (!urlEntrada) {
    console.error('Uso: node scraper.js "<url-de-zonaprop>"');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );

    if (esUrlDeUnaPropiedad(urlEntrada)) {
      // Modo "una sola propiedad" (uso desde la web, on-demand)
      console.log(`Scrapeando propiedad puntual: ${urlEntrada}`);
      const registro = await scrapeFicha(page, urlEntrada);
      await guardarEnSupabase(registro);
    } else {
      // Modo "listado completo" (uso programado / cron)
      console.log(`Buscando publicaciones en: ${urlEntrada}`);
      const urls = await scrapeListado(page, urlEntrada);
      console.log(`Encontradas ${urls.length} publicaciones.`);

      for (const url of urls) {
        try {
          const detailPage = await browser.newPage();
          const registro = await scrapeFicha(detailPage, url);
          await detailPage.close();
          await guardarEnSupabase(registro);
          await sleep(1500 + Math.random() * 1500); // evitar rate-limit / bloqueo
        } catch (err) {
          console.error(`  ✗ Error en ${url}:`, err.message);
        }
      }
    }
  } finally {
    await browser.close();
  }
}

main();
