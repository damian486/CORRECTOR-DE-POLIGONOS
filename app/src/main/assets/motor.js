/* Motor de revisión y corrección de polígonos.
   Trabaja en coordenadas geográficas (WGS84) y calcula áreas en metros cuadrados.
   Depende de JSTS (window.jsts). */
(function (global) {
  'use strict';
  const jsts = global.jsts;
  const gf = new jsts.geom.GeometryFactory();
  const reader = new jsts.io.GeoJSONReader(gf);
  const writer = new jsts.io.GeoJSONWriter();
  const Coord = jsts.geom.Coordinate;

  // 1 cuerda = 30 × 30 varas; 1 vara = 0.835905 m
  const M2_POR_CUERDA = Math.pow(30 * 0.835905, 2);
  const RADIO = 6378137;

  // ---------- Áreas geodésicas ----------
  function areaAnillo(c) {
    let total = 0;
    const n = c.length;
    if (n < 3) return 0;
    for (let i = 0; i < n; i++) {
      const p1 = c[i], p2 = c[(i + 1) % n], p3 = c[(i + 2) % n];
      total += (rad(p3[0]) - rad(p1[0])) * Math.sin(rad(p2[1]));
    }
    return Math.abs(total * RADIO * RADIO / 2);
  }
  function rad(g) { return g * Math.PI / 180; }
  // GTM: proyección oficial de Guatemala (Transversa de Mercator, meridiano central -90.5)
  const GTM_PROJ = '+proj=tmerc +lat_0=0 +lon_0=-90.5 +k=0.9998 +x_0=500000 +y_0=0 +ellps=WGS84 +units=m +no_defs';
  const GTM_WKT = 'PROJCS["GTM",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-90.5],PARAMETER["Scale_Factor",0.9998],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
  const proj4 = global.proj4;
  const aGTMpt = proj4 ? proj4('EPSG:4326', GTM_PROJ) : null;

  function transformar(geom, fn) {
    const ring = r => r.map(c => fn([c[0], c[1]]));
    if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(ring) };
    if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map(p => p.map(ring)) };
    return geom;
  }
  function aGTM(geom) { return transformar(geom, c => aGTMpt.forward(c)); }
  function deGTM(geom) { return transformar(geom, c => aGTMpt.inverse(c)); }
  function ptoGTM(lonlat) { return aGTMpt ? aGTMpt.forward(lonlat) : null; }

  // Área plana en GTM (la misma que muestra QGIS con una capa en GTM)
  function areaPlana(c) {
    let s = 0;
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) s += (c[j][0] + c[i][0]) * (c[j][1] - c[i][1]);
    return Math.abs(s / 2);
  }
  function areaPoligonoGTM(anillos) {
    if (!anillos.length) return 0;
    const pr = anillos.map(r => r.map(c => aGTMpt.forward([c[0], c[1]])));
    let a = areaPlana(pr[0]);
    for (let i = 1; i < pr.length; i++) a -= areaPlana(pr[i]);
    return Math.max(0, a);
  }

  function areaGeo(geom) {
    if (!geom) return 0;
    if (aGTMpt) {
      if (geom.type === 'Polygon') return areaPoligonoGTM(geom.coordinates);
      if (geom.type === 'MultiPolygon') return geom.coordinates.reduce((s, p) => s + areaPoligonoGTM(p), 0);
      if (geom.type === 'GeometryCollection') return geom.geometries.reduce((s, g) => s + areaGeo(g), 0);
      return 0;
    }
    return areaGeoEsfera(geom);
  }
  function areaGeoEsfera(geom) {
    if (!geom) return 0;
    if (geom.type === 'Polygon') return areaPoligono(geom.coordinates);
    if (geom.type === 'MultiPolygon') return geom.coordinates.reduce((s, p) => s + areaPoligono(p), 0);
    if (geom.type === 'GeometryCollection') return geom.geometries.reduce((s, g) => s + areaGeoEsfera(g), 0);
    return 0;
  }
  function areaPoligono(anillos) {
    if (!anillos.length) return 0;
    let a = areaAnillo(anillos[0]);
    for (let i = 1; i < anillos.length; i++) a -= areaAnillo(anillos[i]);
    return Math.max(0, a);
  }
  function areaJ(g) { return g && !g.isEmpty() ? areaGeo(aGeo(g)) : 0; }

  // ---------- Conversión ----------
  function limpiarCoords(geom) {
    // quita Z/M y cierra anillos abiertos
    const anillo = r => {
      const out = r.filter(p => p && isFinite(p[0]) && isFinite(p[1])).map(p => [p[0], p[1]]);
      if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0].slice());
      return out;
    };
    if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(anillo) };
    if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map(p => p.map(anillo)) };
    return null;
  }
  function aJ(geom) { return reader.read(geom); }
  function aGeo(g) { return writer.write(g); }
  function soloPoligonos(g) {
    // extrae polígonos de cualquier resultado (por ejemplo, colecciones con líneas)
    const partes = [];
    const recorrer = x => {
      if (!x || x.isEmpty()) return;
      const t = x.getGeometryType();
      if (t === 'Polygon') partes.push(x);
      else if (t === 'MultiPolygon' || t === 'GeometryCollection') {
        for (let i = 0; i < x.getNumGeometries(); i++) recorrer(x.getGeometryN(i));
      }
    };
    recorrer(g);
    if (!partes.length) return null;
    return partes.length === 1 ? partes[0] : gf.createMultiPolygon(partes);
  }

  // ---------- Validez ----------
  const MOTIVOS = {
    0: 'Error de geometría',
    1: 'Puntos repetidos',
    2: 'Un hueco interior queda fuera del polígono',
    3: 'Huecos uno dentro de otro',
    4: 'El interior queda partido en dos',
    5: 'Los bordes se cruzan (forma de moño)',
    6: 'El borde se toca a sí mismo',
    7: 'Partes del polígono encimadas',
    8: 'Anillos duplicados',
    9: 'Muy pocos vértices para formar un polígono',
    10: 'Coordenada inválida',
    11: 'El anillo no está cerrado'
  };
  function revisarValidez(g) {
    try {
      const op = new jsts.operation.valid.IsValidOp(g);
      if (op.isValid()) return null;
      const e = op.getValidationError();
      const c = e.getCoordinate();
      return { motivo: MOTIVOS[e.getErrorType()] || e.getMessage(), punto: c ? [c.x, c.y] : null };
    } catch (err) {
      return { motivo: 'No se pudo leer la geometría', punto: null };
    }
  }

  // Punto dentro del anillo por regla par-impar
  function dentroParImpar(x, y, anillos) {
    let dentro = false;
    for (const r of anillos) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) dentro = !dentro;
      }
    }
    return dentro;
  }

  // Corrige un polígono simple (lista de anillos) conservando todas sus partes
  function corregirAnillos(anillos) {
    const lineas = anillos
      .filter(r => r.length >= 4)
      .map(r => gf.createLineString(r.map(p => new Coord(p[0], p[1]))));
    if (!lineas.length) return null;
    const noded = gf.createMultiLineString(lineas).union();
    const P = new jsts.operation.polygonize.Polygonizer();
    P.add(noded);
    const caras = P.getPolygons().toArray().filter(p => {
      if (p.getArea() === 0) return false;
      const ip = p.getInteriorPoint().getCoordinate();
      return dentroParImpar(ip.x, ip.y, anillos);
    });
    if (!caras.length) return null;
    return jsts.operation.union.UnaryUnionOp.union(gf.createGeometryCollection(caras));
  }

  function corregirGeom(geom) {
    const limpio = limpiarCoords(geom);
    if (!limpio) return null;
    const partes = limpio.type === 'Polygon' ? [limpio.coordinates] : limpio.coordinates;
    let res = [];
    try {
      for (const p of partes) {
        const g = corregirAnillos(p);
        if (g && !g.isEmpty()) res.push(g);
      }
      if (!res.length) return null;
      const u = res.length === 1 ? res[0] : jsts.operation.union.UnaryUnionOp.union(gf.createGeometryCollection(res));
      const s = soloPoligonos(u);
      return s ? aGeo(s) : null;
    } catch (e) {
      try {
        const b = soloPoligonos(aJ(limpio).buffer(0));
        return b ? aGeo(b) : null;
      } catch (e2) { return null; }
    }
  }

  // ---------- Etiquetas ----------
  const CAMPOS_NOMBRE = ['benef', 'beneficiar', 'beneficiario', 'nombre', 'name', 'propietari', 'parcela', 'codigo', 'código', 'id_parcela', 'poli', 'id', 'fid', 'objectid'];
  function campoEtiqueta(features) {
    const claves = new Set();
    features.slice(0, 50).forEach(f => Object.keys(f.properties || {}).forEach(k => claves.add(k)));
    const lista = [...claves];
    for (const c of CAMPOS_NOMBRE) {
      const k = lista.find(x => x.toLowerCase() === c);
      if (k) return k;
    }
    for (const c of CAMPOS_NOMBRE) {
      if (c.length < 4) continue;
      const k = lista.find(x => x.toLowerCase().includes(c));
      if (k) return k;
    }
    return null;
  }

  // ---------- Capa ----------
  // inicio: número desde el que se numeran los identificadores (p1, p2…); capaId: a qué capa pertenecen
  function prepararCapa(fc, inicio, capaId) {
    inicio = inicio || 0;
    const feats = [];
    let ignoradas = 0;
    (fc.features || []).forEach(f => {
      const g = f && f.geometry;
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) { ignoradas++; return; }
      feats.push({ type: 'Feature', properties: Object.assign({}, f.properties || {}), geometry: g });
    });
    feats.forEach((f, i) => { f._uid = 'p' + (inicio + i + 1); f._num = inicio + i + 1; f._capa = capaId || 0; });
    const campo = campoEtiqueta(feats);
    etiquetar(feats, campo);
    return { features: feats, ignoradas, campoEtiqueta: campo };
  }

  const ES_ID = /^(o?fid_?|id|objectid|oid)$/i;
  function etiquetar(feats, campo) {
    feats.forEach(f => {
      const v = campo ? f.properties[campo] : null;
      const hay = v !== null && v !== undefined && String(v).trim() !== '';
      f._etiqueta = hay ? (ES_ID.test(campo) ? 'Polígono ' + String(v).trim() : String(v).trim()) : 'Polígono ' + f._num;
    });
  }

  // ---------- Análisis ----------
  const OPCIONES = { traslapeMin: 1, areaMin: 10, huecoMax: 2000 };

  function analizar(capa, opc) {
    opc = Object.assign({}, OPCIONES, opc || {});
    const problemas = [];
    const reparadas = []; // geometría utilizable para cruces
    let n = 0;
    const id = t => t + '-' + (++n);

    capa.features.forEach(f => {
      f._area = 0;
      let g = null;
      try { g = aJ(limpiarCoords(f.geometry)); } catch (e) { g = null; }
      const v = g ? revisarValidez(g) : { motivo: 'No se pudo leer la geometría', punto: null };
      let util = g;
      if (v) {
        problemas.push({ id: id('inv'), tipo: 'invalida', fid: f._uid, motivo: v.motivo, punto: v.punto });
        const c = corregirGeom(f.geometry);
        util = c ? aJ(c) : null;
      }
      if (util && !util.isEmpty()) {
        f._area = areaJ(util);
        reparadas.push({ f, g: util, env: util.getEnvelopeInternal() });
      }
    });

    // pequeñas
    reparadas.forEach(({ f }) => {
      if (f._area < opc.areaMin) problemas.push({ id: id('peq'), tipo: 'pequena', fid: f._uid, area: f._area });
    });

    // duplicadas y traslapes
    for (let i = 0; i < reparadas.length; i++) {
      for (let j = i + 1; j < reparadas.length; j++) {
        const A = reparadas[i], B = reparadas[j];
        if (!A.env.intersects(B.env)) continue;
        let inter;
        try { inter = soloPoligonos(A.g.intersection(B.g)); } catch (e) { continue; }
        if (!inter) continue;
        const a = areaJ(inter);
        if (a < opc.traslapeMin) continue;
        const menor = Math.min(A.f._area, B.f._area) || 1;
        if (a / menor > 0.98 && Math.abs(A.f._area - B.f._area) / menor < 0.02) {
          problemas.push({ id: id('dup'), tipo: 'duplicada', fid: A.f._uid, fid2: B.f._uid, area: a });
        } else {
          problemas.push({ id: id('tras'), tipo: 'traslape', fid: A.f._uid, fid2: B.f._uid, area: a, geom: aGeo(inter) });
        }
      }
    }

    // huecos entre parcelas vecinas
    if (reparadas.length > 1) {
      try {
        const u = jsts.operation.union.UnaryUnionOp.union(gf.createGeometryCollection(reparadas.map(r => r.g)));
        const polys = [];
        for (let i = 0; i < u.getNumGeometries(); i++) polys.push(u.getGeometryN(i));
        polys.forEach(p => {
          if (p.getGeometryType() !== 'Polygon') return;
          for (let k = 0; k < p.getNumInteriorRing(); k++) {
            const hueco = gf.createPolygon(gf.createLinearRing(p.getInteriorRingN(k).getCoordinates()));
            const a = areaJ(hueco);
            if (a <= 0 || a > opc.huecoMax) continue;
            const env = hueco.getEnvelopeInternal();
            const vecinos = reparadas
              .filter(r => r.env.intersects(env) && r.g.distance(hueco) < 1e-7)
              .map(r => r.f._uid);
            problemas.push({ id: id('hue'), tipo: 'hueco', area: a, geom: aGeo(hueco), vecinos });
          }
        });
      } catch (e) { /* si la unión falla, se omite la búsqueda de huecos */ }
    }

    const cuenta = { invalida: 0, traslape: 0, hueco: 0, duplicada: 0, pequena: 0 };
    problemas.forEach(p => cuenta[p.tipo]++);
    return { problemas, cuenta, total: problemas.length };
  }

  // ---------- Correcciones ----------
  function buscar(capa, uid) { return capa.features.find(f => f._uid === uid); }

  function corregirInvalida(capa, uid) {
    const f = buscar(capa, uid);
    if (!f) return 'No se encontró el polígono.';
    const c = corregirGeom(f.geometry);
    if (!c) { capa.features = capa.features.filter(x => x !== f); return 'El polígono no tenía área y se eliminó.'; }
    f.geometry = c;
    return null;
  }

  function corregirTodasInvalidas(capa, problemas) {
    let n = 0;
    problemas.filter(p => p.tipo === 'invalida').forEach(p => { if (!corregirInvalida(capa, p.fid)) n++; });
    return n;
  }

  function recortar(capa, quitarDe, otro) {
    const A = buscar(capa, quitarDe), B = buscar(capa, otro);
    if (!A || !B) return 'No se encontraron los polígonos.';
    const ga = aJ(corregirGeom(A.geometry) || limpiarCoords(A.geometry));
    const gb = aJ(corregirGeom(B.geometry) || limpiarCoords(B.geometry));
    const r = soloPoligonos(ga.difference(gb));
    if (!r) return 'Al recortar, el polígono se quedaría sin área. Mejor elimínalo.';
    A.geometry = aGeo(r);
    return null;
  }

  function rellenar(capa, huecoGeom, asignarA) {
    const f = buscar(capa, asignarA);
    if (!f) return 'No se encontró el polígono.';
    const g = aJ(corregirGeom(f.geometry) || limpiarCoords(f.geometry));
    const r = soloPoligonos(g.union(aJ(huecoGeom)));
    if (!r) return 'No se pudo unir el hueco.';
    f.geometry = aGeo(r);
    return null;
  }

  function eliminar(capa, uid) {
    const antes = capa.features.length;
    capa.features = capa.features.filter(f => f._uid !== uid);
    return capa.features.length < antes ? null : 'No se encontró el polígono.';
  }

  // ---------- Exportar ----------
  function aMulti(geom) {
    return geom.type === 'MultiPolygon' ? geom : { type: 'MultiPolygon', coordinates: [geom.coordinates] };
  }
  function geojsonLimpio(capa) {
    return {
      type: 'FeatureCollection',
      features: capa.features.map(f => ({ type: 'Feature', properties: f.properties, geometry: f.geometry }))
    };
  }
  function geojsonParaShape(capa) {
    return {
      type: 'FeatureCollection',
      features: capa.features.map(f => {
        const props = {};
        Object.keys(f.properties).forEach(k => {
          const v = f.properties[k];
          props[k] = (v === null || v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
        });
        return { type: 'Feature', properties: props, geometry: aMulti(f.geometry) };
      })
    };
  }

  function formatoArea(m2) {
    if (m2 >= 10000) return (m2 / 10000).toFixed(4) + ' ha';
    if (m2 >= M2_POR_CUERDA) return (m2 / M2_POR_CUERDA).toFixed(1) + ' cuerdas';
    return Math.round(m2).toLocaleString('es-GT') + ' m²';
  }
  function areaCompleta(m2) {
    return [Math.round(m2).toLocaleString('es-GT') + ' m²',
      (m2 / M2_POR_CUERDA).toFixed(2) + ' cuerdas', (m2 / 10000).toFixed(4) + ' ha'];
  }

  function centro(geom) {
    try { const c = aJ(limpiarCoords(geom)).getInteriorPoint().getCoordinate(); return [c.x, c.y]; }
    catch (e) { return null; }
  }

  global.Motor = {
    centro, etiquetar, aGTM, deGTM, ptoGTM, GTM_WKT, campoEtiqueta, ES_ID,
    prepararCapa, analizar, corregirGeom, corregirInvalida, corregirTodasInvalidas,
    recortar, rellenar, eliminar, buscar, areaGeo, formatoArea, areaCompleta,
    geojsonLimpio, geojsonParaShape, M2_POR_CUERDA, OPCIONES
  };
})(typeof window !== 'undefined' ? window : this);
