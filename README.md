# Zonaprop Scraper

## Setup
```
npm install
cp .env.example .env
```
Completar `.env` con la `service_role key` de Supabase (Project Settings → API → service_role, **no** la publishable/anon).

## Uso manual
```
node scraper.js "https://www.zonaprop.com.ar/departamentos-alquiler-palermo.html"
```

## Automatización (n8n / cron)
Ejecutar como comando programado, ej. cron cada 6h:
```
0 */6 * * * cd /ruta/zonaprop-scraper && node scraper.js "URL" >> log.txt 2>&1
```
En n8n: nodo "Execute Command" apuntando al mismo comando, o un nodo HTTP si se envuelve el script en un endpoint.

## Mantenimiento
Si Zonaprop cambia el HTML, el script deja de encontrar datos (columnas quedan `null` o vacías). Ajustar únicamente el objeto `SELECTORS` en `scraper.js` — no hace falta tocar el resto de la lógica.

## Datos guardados (tabla `propiedades_zonaprop` en Supabase)
título, descripción, precio, moneda, expensas, ubicación, m², ambientes, dormitorios, baños, inmobiliaria/contacto, teléfono, fotos (array de URLs), timestamps.

Usa `upsert` por `zonaprop_id`, así corridas repetidas actualizan precio/estado en vez de duplicar filas — útil para trackear variación de precios en el tiempo.
