/**
 * Detector de oportunidades Zonaprop
 * Compara cada propiedad activa contra el promedio de precio/m2 de su barrio
 * (vista vw_precio_m2_barrio, ignora barrios con menos de MUESTRA_MINIMA publicaciones)
 * y avisa por mail (Resend) las que estén UMBRAL_PCT% o más debajo del promedio,
 * sin repetir avisos ya enviados (tabla zonaprop_oportunidades).
 *
 * Requiere .env con:
 *   SUPABASE_URL=
 *   SUPABASE_SERVICE_ROLE_KEY=
 *   RESEND_API_KEY=
 *   ALERTA_EMAIL_TO=  (a quién avisar)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const UMBRAL_PCT = 10;      // % debajo del promedio de zona para ser "oportunidad"
const MUESTRA_MINIMA = 5;   // barrios con menos publicaciones que esto se ignoran

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERTA_EMAIL_TO = process.env.ALERTA_EMAIL_TO;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}
if (!RESEND_API_KEY || !ALERTA_EMAIL_TO) {
  console.error('Faltan RESEND_API_KEY / ALERTA_EMAIL_TO en .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function fmtMoney(n, moneda) {
  if (n == null) return '-';
  return `${moneda === 'USD' ? 'U$S' : '$'} ${Math.round(n).toLocaleString('es-AR')}`;
}

async function enviarMail(oportunidades) {
  const filas = oportunidades.map((o) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;"><a href="${o.url}">${o.titulo || o.zonaprop_id}</a></td>
      <td style="padding:8px;border-bottom:1px solid #eee;">${o.ubicacion || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;">${fmtMoney(o.precio, o.moneda)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;">${fmtMoney(o.precio_m2, o.moneda)}/m²</td>
      <td style="padding:8px;border-bottom:1px solid #eee;">${fmtMoney(o.precio_m2_promedio_zona, o.moneda)}/m²</td>
      <td style="padding:8px;border-bottom:1px solid #eee;color:#0a7d2c;font-weight:bold;">-${o.porcentaje_debajo.toFixed(1)}%</td>
    </tr>`).join('');

  const html = `
    <h2>Oportunidades detectadas en Zonaprop</h2>
    <p>${oportunidades.length} propiedad(es) al menos ${UMBRAL_PCT}% debajo del precio/m² promedio de su zona.</p>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px;">
      <thead>
        <tr style="background:#0a1f44;color:#fff;">
          <th style="padding:8px;text-align:left;">Título</th>
          <th style="padding:8px;text-align:left;">Barrio</th>
          <th style="padding:8px;text-align:left;">Precio</th>
          <th style="padding:8px;text-align:left;">$/m²</th>
          <th style="padding:8px;text-align:left;">Promedio zona</th>
          <th style="padding:8px;text-align:left;">Diferencia</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Tasador Team Conectar <alertas@teamconectar.com.ar>',
      to: [ALERTA_EMAIL_TO],
      subject: `${oportunidades.length} oportunidad(es) detectadas en Zonaprop`,
      html,
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend respondió ${res.status}: ${await res.text()}`);
  }
}

async function main() {
  // 1) Promedios válidos por barrio (con muestra suficiente)
  const { data: promedios, error: errProm } = await supabase
    .from('vw_precio_m2_barrio')
    .select('*')
    .gte('muestra_n', MUESTRA_MINIMA);

  if (errProm) {
    console.error('Error leyendo vw_precio_m2_barrio:', errProm.message);
    process.exit(1);
  }

  if (!promedios.length) {
    console.log('Sin barrios con muestra suficiente todavía. Nada para comparar.');
    return;
  }

  const promKey = (ubicacion, operacion, tipo, moneda) => `${ubicacion}|${operacion}|${tipo}|${moneda}`;
  const mapaPromedios = new Map(
    promedios.map((p) => [promKey(p.ubicacion, p.tipo_operacion, p.tipo_propiedad, p.moneda), p])
  );

  // 2) Propiedades activas ya notificadas (para no repetir aviso)
  const { data: yaNotificadas, error: errNotif } = await supabase
    .from('zonaprop_oportunidades')
    .select('propiedad_id');
  if (errNotif) {
    console.error('Error leyendo zonaprop_oportunidades:', errNotif.message);
    process.exit(1);
  }
  const idsNotificados = new Set(yaNotificadas.map((n) => n.propiedad_id));

  // 3) Propiedades activas con precio y m2 válidos
  const { data: propiedades, error: errProp } = await supabase
    .from('propiedades_zonaprop')
    .select('*')
    .eq('activo', true)
    .not('precio', 'is', null)
    .not('m2_totales', 'is', null);
  if (errProp) {
    console.error('Error leyendo propiedades_zonaprop:', errProp.message);
    process.exit(1);
  }

  const oportunidades = [];
  for (const p of propiedades) {
    if (idsNotificados.has(p.id)) continue;
    if (!p.m2_totales || p.m2_totales <= 0) continue;

    const prom = mapaPromedios.get(promKey(p.ubicacion, p.tipo_operacion, p.tipo_propiedad, p.moneda));
    if (!prom) continue; // barrio sin muestra suficiente -> se ignora

    const precioM2 = p.precio / p.m2_totales;
    const promedioZona = Number(prom.precio_m2_promedio);
    const porcentajeDebajo = ((promedioZona - precioM2) / promedioZona) * 100;

    if (porcentajeDebajo >= UMBRAL_PCT) {
      oportunidades.push({
        ...p,
        precio_m2: precioM2,
        precio_m2_promedio_zona: promedioZona,
        porcentaje_debajo: porcentajeDebajo,
      });
    }
  }

  if (!oportunidades.length) {
    console.log('No se detectaron oportunidades nuevas.');
    return;
  }

  console.log(`Detectadas ${oportunidades.length} oportunidad(es). Enviando mail...`);
  await enviarMail(oportunidades);

  const registros = oportunidades.map((o) => ({
    propiedad_id: o.id,
    precio_m2: o.precio_m2,
    precio_m2_promedio_zona: o.precio_m2_promedio_zona,
    porcentaje_debajo: o.porcentaje_debajo,
  }));
  const { error: errInsert } = await supabase.from('zonaprop_oportunidades').insert(registros);
  if (errInsert) console.error('Error guardando oportunidades notificadas:', errInsert.message);
  else console.log('Mail enviado y oportunidades registradas.');
}

main().catch((e) => {
  console.error('Error general:', e.message);
  process.exit(1);
});
