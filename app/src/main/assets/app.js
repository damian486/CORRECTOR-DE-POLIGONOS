(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const COLORES = { invalida: '#7B3FA0', traslape: '#D2344B', hueco: '#E2B227', duplicada: '#2F6F8F', pequena: '#2F6F8F' };
  const NOMBRES = {
    invalida: ['Error de geometría', 'Errores de geometría'],
    traslape: ['Parcelas encimadas', 'Parcelas encimadas'],
    hueco: ['Hueco entre vecinos', 'Huecos entre vecinos'],
    duplicada: ['Copia repetida', 'Copias repetidas'],
    pequena: ['Demasiado pequeña', 'Demasiado pequeñas']
  };
  const ORDEN = ['invalida', 'traslape', 'hueco', 'duplicada', 'pequena'];
  const MODELO_POR_DEFECTO = 'claude-sonnet-5-5';
  // colores de borde y relleno para cada capa abierta (la primera, la segunda…)
  const BORDE_CAPA = ['#FFFFFF', '#9BE15D', '#7FD3FF', '#FFB0E0'];
  const RELLENO_CAPA = ['#2E6B52', '#9BE15D', '#7FD3FF', '#FFB0E0'];

  const estado = {
    capa: null, capas: [], analisis: null, nombre: '', crs: '', historial: [],
    sel: null, chat: [], pdf: null, cargandoClaude: false, fotoProblemas: {}
  };

  // ---------- Ajustes ----------
  function leerAjuste(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : v; } catch (e) { return def; } }
  function ponerAjuste(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
  function opciones() {
    return {
      traslapeMin: parseFloat(leerAjuste('traslapeMin', '1')) || 0,
      areaMin: parseFloat(leerAjuste('areaMin', '10')) || 0,
      huecoMax: parseFloat(leerAjuste('huecoMax', '2000')) || 0
    };
  }

  // ---------- Avisos ----------
  let temporizador;
  function avisar(t) {
    const a = $('aviso'); a.textContent = t; a.classList.add('ver');
    clearTimeout(temporizador); temporizador = setTimeout(() => a.classList.remove('ver'), 2600);
  }
  function cargando(si, texto) { $('cargandoTexto').textContent = texto || 'Revisando…'; $('cargando').classList.toggle('ver', si); }
  const esperar = () => new Promise(r => setTimeout(r, 30));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Mapa ----------
  const mapa = L.map('mapa', { zoomControl: false, attributionControl: true, maxZoom: 21, tap: true, touchZoom: true, bounceAtZoomLimits: false }).setView([14.75, -91.2], 11);
  L.control.zoom({ position: 'topright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(mapa);
  const fondos = {
    'Satélite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 17, attribution: 'Esri, Maxar' }),
    'Calles': L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 21, maxNativeZoom: 19, subdomains: 'abcd', attribution: '© OpenStreetMap © CARTO' })
  };
  let fondoActual = 'Satélite';
  fondos[fondoActual].addTo(mapa);
  $('btnFondo').onclick = () => {
    mapa.removeLayer(fondos[fondoActual]);
    const otro = fondoActual === 'Satélite' ? 'Calles' : 'Satélite';
    fondos[otro].addTo(mapa);
    $('btnFondo').textContent = fondoActual;
    fondoActual = otro;
  };
  const capaParcelas = L.featureGroup().addTo(mapa);
  const capaProblemas = L.featureGroup().addTo(mapa);

  function dibujar() {
    capaParcelas.clearLayers(); capaProblemas.clearLayers();
    if (!estado.capa) return;
    const conProblema = new Set();
    estado.analisis.problemas.forEach(p => { if (p.fid) conProblema.add(p.fid); if (p.fid2) conProblema.add(p.fid2); });
    estado.capa.features.forEach(f => {
      const malo = conProblema.has(f._uid), k = (f._capa || 0) % BORDE_CAPA.length;
      const capa = L.geoJSON(f, {
        style: {
          color: malo ? '#FF5A6E' : BORDE_CAPA[k], weight: malo ? 2.5 : 1.8,
          fillColor: malo ? '#D2344B' : RELLENO_CAPA[k], fillOpacity: malo ? .18 : .22
        }
      });
      capa.on('click', e => { L.DomEvent.stopPropagation(e); if (!edicion) mostrarParcela(f, e.latlng); });
      capaParcelas.addLayer(capa);
    });
    const ley = $('leyenda');
    ley.hidden = estado.capas.length < 2;
    ley.innerHTML = estado.capas.map(c => `<span><i style="border-color:${BORDE_CAPA[c.id % 4]};background:${RELLENO_CAPA[c.id % 4]}55"></i>${esc(c.nombre)}</span>`).join('');
    estado.analisis.problemas.forEach(p => {
      let l = null;
      if (p.geom) l = L.geoJSON(p.geom, { style: { color: COLORES[p.tipo], weight: 2, fillColor: COLORES[p.tipo], fillOpacity: .65 } });
      else if (p.tipo === 'invalida' && p.punto) l = L.circleMarker([p.punto[1], p.punto[0]], { radius: 9, color: '#fff', weight: 2, fillColor: COLORES.invalida, fillOpacity: 1 });
      if (l) { l.on('click', e => { L.DomEvent.stopPropagation(e); seleccionar(p.id, false); }); capaProblemas.addLayer(l); }
    });
  }

  // el área de una forma con bordes cruzados se mide sobre su versión corregida
  function areaParcela(f) { return f._area != null ? f._area : Motor.areaGeo(f.geometry); }

  function mostrarParcela(f, latlng) {
    const a = areaParcela(f);
    const filas = Object.keys(f.properties).map(k => `<tr><td>${esc(k)}</td><td>${esc(f.properties[k])}</td></tr>`).join('');
    const areas = Motor.areaCompleta(a).map(esc).join('<br>');
    const div = document.createElement('div'); div.className = 'pop';
    const deCapa = estado.capas.length > 1 ? `<div class="aviso">Capa: ${esc(nombreCapa(f))}</div>` : '';
    div.innerHTML = `<h4>${esc(f._etiqueta)}</h4>${deCapa}<div class="areas">${areas}</div><table>${filas}</table><div class="acciones"><button class="boton primario" data-a="editar">Editar forma</button><button class="boton" data-a="datos">Editar datos</button><button class="boton" data-a="borrar">Borrar polígono</button></div>`;
    div.querySelector('[data-a=editar]').onclick = () => editar(f);
    div.querySelector('[data-a=datos]').onclick = () => { mapa.closePopup(); formularioDatos(f); };
    const bb = div.querySelector('[data-a=borrar]');
    bb.onclick = () => {
      if (!bb.dataset.ok) { bb.dataset.ok = '1'; bb.textContent = 'Toca otra vez para borrar'; bb.style.color = 'var(--rojo)'; return; }
      mapa.closePopup(); guardarHistorial(); Motor.eliminar(estado.capa, f._uid); reanalizar(); avisar('Polígono borrado');
    };
    L.popup({ maxWidth: 290 }).setLatLng(latlng).setContent(div).openOn(mapa);
  }

  function encuadrar() {
    const b = capaParcelas.getBounds();
    if (b.isValid()) mapa.fitBounds(b, { paddingTopLeft: [20, 80], paddingBottomRight: [20, window.innerHeight * 0.46] });
  }

  // ---------- Abrir archivos ----------
  $('btnAbrir').onclick = () => $('archivo').click();
  $('btnAbrir2').onclick = () => $('archivo').click();
  $('archivo').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) await abrir(f);
  };

  async function abrir(archivo) {
    cargando(true, 'Leyendo ' + archivo.name + '…'); await esperar();
    try {
      const nombre = archivo.name;
      const ext = nombre.split('.').pop().toLowerCase();
      const buf = await archivo.arrayBuffer();
      let capas = [], crs = '', esGTM = false, avisoCrs = '';
      if (ext === 'zip' || ext === 'kmz') {
        const zip = await JSZip.loadAsync(buf);
        const archivos = Object.keys(zip.files).filter(n => !zip.files[n].dir && !n.startsWith('__MACOSX'));
        const shpN = archivos.filter(n => /\.shp$/i.test(n));
        const kmlN = archivos.find(n => /\.kml$/i.test(n));
        if (shpN.length) {
          const prj = archivos.find(n => /\.prj$/i.test(n));
          let prjTexto = '';
          if (prj) { prjTexto = await zip.file(prj).async('string'); crs = nombreCrs(prjTexto); }
          const r = await shp(buf);
          (Array.isArray(r) ? r : [r]).forEach(fc => capas.push({ nombre: (fc.fileName || 'capa').split('/').pop(), fc }));
          esGTM = esPrjGTM(prjTexto);
          // sin .prj: si las coordenadas están en metros con valores típicos de GTM, se leen como GTM
          if (!prj) {
            const c0 = primeraCoord(capas);
            if (c0 && Math.abs(c0[0]) > 180) {
              if (c0[0] > 200000 && c0[0] < 800000 && c0[1] > 1400000 && c0[1] < 2000000) {
                capas.forEach(c => c.fc.features.forEach(f => { if (f.geometry && /Polygon/.test(f.geometry.type)) f.geometry = Motor.deGTM(f.geometry); }));
                crs = 'GTM'; esGTM = true;
                avisoCrs = 'El .zip no traía .prj; por los valores de las coordenadas se leyó como GTM.';
              } else throw new Error('El shape no trae .prj y sus coordenadas no son grados ni GTM. Agrega el archivo .prj al .zip.');
            } else crs = 'WGS84 (el .zip no traía .prj)';
          }
        } else if (kmlN) {
          capas.push({ nombre: kmlN, fc: deKml(await zip.file(kmlN).async('string')) });
          crs = 'WGS84';
        } else {
          throw new Error('El .zip no trae un shape (.shp) ni un .kml. Comprime juntos los archivos .shp, .shx, .dbf y .prj.');
        }
      } else if (ext === 'geojson' || ext === 'json') {
        const j = JSON.parse(new TextDecoder().decode(buf));
        capas.push({ nombre, fc: j.type === 'FeatureCollection' ? j : (j.type === 'Feature' ? { type: 'FeatureCollection', features: [j] } : { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: j }] }) });
        crs = 'WGS84';
      } else if (ext === 'kml') {
        capas.push({ nombre, fc: deKml(new TextDecoder().decode(buf)) });
        crs = 'WGS84';
      } else if (['shp', 'dbf', 'shx', 'prj'].includes(ext)) {
        throw new Error('Un shape son varios archivos. Comprime juntos el .shp, .shx, .dbf y .prj en un .zip y ábrelo.');
      } else {
        throw new Error('No reconozco el formato .' + ext + '. Usa shape en .zip, GeoJSON, KML o KMZ.');
      }
      const conPoligonos = capas.filter(c => (c.fc.features || []).some(f => f.geometry && /Polygon/.test(f.geometry.type)));
      if (!conPoligonos.length) throw new Error('El archivo no tiene polígonos. Esta app revisa áreas (parcelas), no puntos ni líneas.');
      cargando(false);
      const elegida = conPoligonos.length === 1 ? conPoligonos[0] : await elegirCapa(conPoligonos);
      if (!elegida) return;
      let modo = 'nueva';
      if (estado.capa && estado.capa.features.length) {
        modo = await preguntarModo(nombre);
        if (!modo) return;
      }
      if (edicion) salirEdicion();
      cargando(true, 'Revisando polígonos…'); await esperar();
      const base = nombre.replace(/\.[^.]+$/, '');
      if (modo === 'agregar') {
        const id = estado.capas.length;
        const inicio = estado.capa.features.reduce((m, f) => Math.max(m, f._num || 0), 0);
        const prep = Motor.prepararCapa(elegida.fc, inicio, id);
        estado.capas.push({ id, nombre: base, crs, esGTM, campoEtiqueta: prep.campoEtiqueta });
        estado.capa.features = estado.capa.features.concat(prep.features);
        estado.historial = [];
        if (prep.ignoradas) avisar(prep.ignoradas + ' elementos que no son polígonos se dejaron fuera.');
        else avisar('Capa agregada: ' + base);
      } else {
        const prep = Motor.prepararCapa(elegida.fc, 0, 0);
        estado.capas = [{ id: 0, nombre: base, crs, esGTM, campoEtiqueta: prep.campoEtiqueta }];
        estado.capa = { features: prep.features };
        estado.historial = []; estado.chat = []; estado.sel = null;
        if (prep.ignoradas) avisar(prep.ignoradas + ' elementos que no son polígonos se dejaron fuera.');
      }
      estado.nombre = estado.capas[0].nombre;
      if (avisoCrs) setTimeout(() => avisar(avisoCrs), 2700);
      actualizarEncabezado();
      prepararSalida();
      $('vacio').hidden = true; $('hoja').hidden = false;
      reanalizar();
      encuadrar();
      $('hoja').className = '';
      renderChat();
    } catch (err) {
      avisar(err.message || 'No se pudo abrir el archivo.');
    } finally { cargando(false); }
  }

  function preguntarModo(nombre) {
    return new Promise(res => {
      const caja = $('elegirCaja');
      caja.innerHTML = `<h3 style="margin:0 0 4px">Ya tienes una capa abierta</h3><p class="aviso">Si agregas ${esc(nombre)} como otra capa, la app revisa también los traslapes entre las dos (por ejemplo, SAF y reforestación).</p>`;
      [['Agregar como otra capa', 'agregar', true], ['Reemplazar la capa actual', 'nueva'], ['Cancelar', null]].forEach(([t, v, prim]) => {
        if (v === 'agregar' && estado.capas.length >= 4) return;
        const b = document.createElement('button'); b.className = 'boton' + (prim ? ' primario' : ''); b.textContent = t;
        b.onclick = () => { $('elegir').classList.remove('abierto'); res(v); };
        caja.appendChild(b);
      });
      $('elegir').classList.add('abierto');
    });
  }

  function nombreCapa(f) { const c = estado.capas[f._capa || 0]; return c ? c.nombre : ''; }
  function actualizarEncabezado() {
    const n = estado.capa.features.length;
    $('nombreArchivo').textContent = estado.capas.length > 1
      ? estado.capas.length + ' capas (' + n + ' polígonos)'
      : estado.capas[0].nombre + ' (' + n + ' polígonos)';
  }

  function deKml(texto) {
    const dom = new DOMParser().parseFromString(texto, 'text/xml');
    return toGeoJSON.kml(dom);
  }
  function esPrjGTM(prj) {
    return /central_meridian"?\s*,\s*-90\.5\b/i.test(prj) && /0\.9998/.test(prj);
  }
  function primeraCoord(capas) {
    for (const c of capas) for (const f of (c.fc.features || [])) {
      const g = f.geometry; if (!g) continue;
      if (g.type === 'Polygon' && g.coordinates[0] && g.coordinates[0][0]) return g.coordinates[0][0];
      if (g.type === 'MultiPolygon' && g.coordinates[0] && g.coordinates[0][0]) return g.coordinates[0][0][0];
    }
    return null;
  }
  function nombreCrs(prj) {
    const m = prj.match(/^\s*(PROJCS|GEOGCS|PROJCRS|GEOGCRS)\["([^"]+)"/);
    return m ? m[2].replace(/_/g, ' ') : 'un sistema de coordenadas proyectado';
  }
  function elegirCapa(capas) {
    return new Promise(res => {
      const caja = $('elegirCaja');
      caja.innerHTML = '<h3 style="margin:0 0 4px">¿Qué capa quieres revisar?</h3><p class="aviso">El archivo trae varias capas con polígonos.</p>';
      capas.forEach(c => {
        const b = document.createElement('button'); b.className = 'boton';
        b.textContent = c.nombre + ' (' + c.fc.features.length + ')';
        b.onclick = () => { $('elegir').classList.remove('abierto'); res(c); };
        caja.appendChild(b);
      });
      const x = document.createElement('button'); x.className = 'boton'; x.textContent = 'Cancelar';
      x.onclick = () => { $('elegir').classList.remove('abierto'); res(null); };
      caja.appendChild(x);
      $('elegir').classList.add('abierto');
    });
  }

  // ---------- Análisis y lista ----------
  // Si la capa trae campos de área (AREA_M2, AREA_HA, CUERDAS, DIF_PCT), se actualizan con la forma actual
  function actualizarCamposArea() {
    const porPoli = {};
    estado.capa.features.forEach(f => {
      const p = f.properties;
      if (!('AREA_M2' in p || 'AREA_HA' in p || 'CUERDAS' in p)) return;
      const a = f._area != null ? f._area : Motor.areaGeo(f.geometry);
      if ('AREA_M2' in p) p.AREA_M2 = Math.round(a * 100) / 100;
      if ('AREA_HA' in p) p.AREA_HA = Math.round(a) / 10000;
      if ('CUERDAS' in p) p.CUERDAS = Math.round(a / Motor.M2_POR_CUERDA * 100) / 100;
      if ('Poli' in p) { const k = (f._capa || 0) + ':' + p.Poli; porPoli[k] = (porPoli[k] || 0) + a; }
    });
    estado.capa.features.forEach(f => {
      const p = f.properties;
      if (!('DIF_PCT' in p) || !('Poli' in p)) return;
      const rep = parseFloat(p.AREA_REP), tot = porPoli[(f._capa || 0) + ':' + p.Poli];
      if (rep > 0 && tot != null) p.DIF_PCT = Math.round((tot / 10000 / rep - 1) * 1000) / 10;
    });
  }

  function reanalizar() {
    estado.analisis = Motor.analizar(estado.capa, opciones());
    actualizarCamposArea();
    estado.analisis.problemas.forEach(p => { estado.fotoProblemas[p.id] = p; });
    if (estado.sel && !estado.analisis.problemas.find(p => p.id === estado.sel)) estado.sel = null;
    dibujar(); renderSemaforo(); renderProblemas();
    $('btnDeshacer').disabled = !estado.historial.length;
    if ($('pDatos').classList.contains('activo')) renderDatos();
    if (estado.capa) actualizarEncabezado();
  }

  function renderSemaforo() {
    const c = estado.analisis.cuenta;
    const s = $('semaforo');
    if (!estado.analisis.total) {
      s.innerHTML = `<div class="conteo todo-bien">Sin problemas en ${estado.capa.features.length} polígonos</div>`;
      return;
    }
    s.innerHTML = ORDEN.map(t => `<button class="conteo ${c[t] ? '' : 'cero'}" data-t="${t}"><i style="background:${COLORES[t]}"></i><b>${c[t]}</b>${NOMBRES[t][c[t] === 1 ? 0 : 1].toLowerCase()}</button>`).join('');
    s.querySelectorAll('button').forEach(b => b.onclick = () => {
      verPanel('pProblemas'); if ($('hoja').classList.contains('mini')) $('hoja').className = '';
      const g = $('g-' + b.dataset.t); if (g) g.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function et(uid) {
    const f = Motor.buscar(estado.capa, uid);
    if (!f) return '¿?';
    return estado.capas.length > 1 ? f._etiqueta + ' (' + nombreCapa(f) + ')' : f._etiqueta;
  }
  function areaTxt(m2) { return Motor.formatoArea(m2); }

  function describir(p) {
    switch (p.tipo) {
      case 'invalida': return { que: et(p.fid), detalle: p.motivo };
      case 'traslape': return { que: et(p.fid) + ' y ' + et(p.fid2) + ' se enciman', detalle: 'Área encimada: ' + areaTxt(p.area) };
      case 'duplicada': return { que: et(p.fid) + ' y ' + et(p.fid2), detalle: 'Son el mismo polígono dibujado dos veces' };
      case 'hueco': return { que: 'Hueco entre ' + (p.vecinos.length ? p.vecinos.map(et).join(', ') : 'parcelas'), detalle: areaTxt(p.area) + ' sin asignar' };
      case 'pequena': return { que: et(p.fid), detalle: 'Mide ' + areaTxt(p.area) + '. Puede ser un error al dibujar.' };
    }
  }

  function botones(p) {
    switch (p.tipo) {
      case 'invalida': return [['Corregir forma', () => aplicar({ tipo: 'corregir', fid: p.fid })]];
      case 'traslape': return [
        ['Quitar de ' + et(p.fid), () => aplicar({ tipo: 'recortar', quitar_de: p.fid, otro: p.fid2 })],
        ['Quitar de ' + et(p.fid2), () => aplicar({ tipo: 'recortar', quitar_de: p.fid2, otro: p.fid })]];
      case 'duplicada': return [['Borrar la copia', () => aplicar({ tipo: 'eliminar', fid: p.fid2 })]];
      case 'hueco': return p.vecinos.slice(0, 4).map(v => ['Unir a ' + et(v), () => aplicar({ tipo: 'rellenar', hueco: p.id, asignar_a: v })]);
      case 'pequena': return [['Borrar', () => aplicar({ tipo: 'eliminar', fid: p.fid })]];
    }
    return [];
  }

  function renderProblemas() {
    const cont = $('pProblemas');
    cont.innerHTML = '';
    const ps = estado.analisis.problemas;
    if (!ps.length) {
      cont.innerHTML = `<div class="listo"><strong>Todo en orden</strong><span class="aviso">No hay bordes cruzados, traslapes, huecos ni copias. Ya puedes guardar el archivo.</span></div>`;
      return;
    }
    const nInv = estado.analisis.cuenta.invalida;
    if (nInv > 1) {
      const b = document.createElement('button'); b.className = 'boton primario ancho';
      b.textContent = 'Corregir las ' + nInv + ' formas con error';
      b.onclick = () => { guardarHistorial(); const n = Motor.corregirTodasInvalidas(estado.capa, ps); reanalizar(); avisar(n + ' formas corregidas'); };
      cont.appendChild(b);
    }
    ORDEN.forEach(t => {
      const delTipo = ps.filter(p => p.tipo === t);
      if (!delTipo.length) return;
      const h = document.createElement('div'); h.className = 'grupo-titulo'; h.id = 'g-' + t;
      h.textContent = NOMBRES[t][delTipo.length === 1 ? 0 : 1] + ' (' + delTipo.length + ')';
      cont.appendChild(h);
      delTipo.forEach(p => {
        const d = describir(p);
        const el = document.createElement('div');
        el.className = 'problema' + (estado.sel === p.id ? ' sel' : ''); el.id = 'pr-' + p.id;
        el.style.setProperty('--c', COLORES[t]);
        el.innerHTML = `<div class="barra"></div><div class="cuerpo"><button class="que">${esc(d.que)}</button><div class="detalle">${esc(d.detalle)}</div><div class="acciones"></div></div>`;
        el.querySelector('.que').onclick = () => seleccionar(p.id, true);
        const acc = el.querySelector('.acciones');
        botones(p).forEach(([txt, fn]) => { const b = document.createElement('button'); b.textContent = txt; b.onclick = fn; acc.appendChild(b); });
        const ver = document.createElement('button'); ver.textContent = 'Ver en el mapa'; ver.onclick = () => seleccionar(p.id, true);
        acc.appendChild(ver);
        cont.appendChild(el);
      });
    });
  }

  function seleccionar(id, mover) {
    const p = estado.analisis.problemas.find(x => x.id === id);
    if (!p) return;
    estado.sel = id;
    document.querySelectorAll('.problema').forEach(e => e.classList.toggle('sel', e.id === 'pr-' + id));
    const grupo = L.featureGroup();
    [p.fid, p.fid2].concat(p.vecinos || []).filter(Boolean).forEach(uid => {
      const f = Motor.buscar(estado.capa, uid); if (f) grupo.addLayer(L.geoJSON(f));
    });
    if (p.geom) grupo.addLayer(L.geoJSON(p.geom));
    if (p.punto) grupo.addLayer(L.circleMarker([p.punto[1], p.punto[0]], { radius: 1 }));
    const b = grupo.getBounds();
    if (b.isValid()) mapa.fitBounds(b, { paddingTopLeft: [30, 90], paddingBottomRight: [30, window.innerHeight * 0.48], maxZoom: 21 });
    if (!mover) {
      verPanel('pProblemas'); if ($('hoja').classList.contains('mini')) $('hoja').className = '';
      const el = $('pr-' + id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ---------- Correcciones ----------
  function guardarHistorial() {
    estado.historial.push(JSON.stringify(estado.capa.features));
    if (estado.historial.length > 30) estado.historial.shift();
  }
  $('btnDeshacer').onclick = () => {
    const prev = estado.historial.pop();
    if (!prev) return;
    estado.capa.features = JSON.parse(prev);
    reanalizar(); avisar('Cambio deshecho');
  };

  // Aplica una acción; las de Claude usan identificadores de parcela (p1, p2…) y de hueco
  function aplicar(a, silencioso) {
    let err = null;
    guardarHistorial();
    try {
      if (a.tipo === 'corregir') err = Motor.corregirInvalida(estado.capa, a.fid);
      else if (a.tipo === 'recortar') err = Motor.recortar(estado.capa, a.quitar_de, a.otro);
      else if (a.tipo === 'eliminar') err = Motor.eliminar(estado.capa, a.fid);
      else if (a.tipo === 'rellenar') {
        const h = estado.fotoProblemas[a.hueco];
        err = h && h.geom ? Motor.rellenar(estado.capa, h.geom, a.asignar_a) : 'Ese hueco ya no existe.';
      } else err = 'Acción desconocida.';
    } catch (e) { err = 'No se pudo aplicar: ' + e.message; }
    if (err) { estado.historial.pop(); if (!silencioso) avisar(err); return err; }
    reanalizar();
    if (!silencioso) avisar({ corregir: 'Forma corregida', recortar: 'Área encimada quitada', eliminar: 'Polígono borrado', rellenar: 'Hueco unido' }[a.tipo]);
    return null;
  }

  // ---------- Editar vértices ----------
  let edicion = null;
  const capaEdicion = L.layerGroup().addTo(mapa);
  const iconoPunto = sel => L.divIcon({ className: 'vertice' + (sel ? ' sel' : ''), html: '<i></i>', iconSize: [30, 30] });
  const iconoMedio = L.divIcon({ className: 'medio', html: '<i></i>', iconSize: [26, 26] });

  function editar(f) {
    mapa.closePopup();
    const g = f.geometry;
    const partes = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(p => p.map(r => {
      const a = r.map(c => [c[0], c[1]]);
      if (a.length > 1 && a[0][0] === a[a.length - 1][0] && a[0][1] === a[a.length - 1][1]) a.pop();
      return a;
    }).filter(r => r.length >= 3));
    edicion = { f, partes: partes.filter(p => p.length), sel: null };
    const total = edicion.partes.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0);
    if (total > 1500) avisar('Este polígono tiene ' + total + ' puntos; la edición puede ir lenta.');
    mapa.removeLayer(capaProblemas);
    $('hoja').hidden = true; $('barraEdicion').hidden = false;
    $('edNombre').textContent = f._etiqueta;
    dibujarEdicion();
    const b = edicion.poly.getBounds();
    if (b.isValid()) mapa.fitBounds(b, { paddingTopLeft: [30, 90], paddingBottomRight: [30, 230], maxZoom: 21 });
  }

  const aLatLng = () => edicion.partes.map(p => p.map(r => r.map(c => [c[1], c[0]])));
  const esSel = (pi, ri, vi) => edicion.sel && edicion.sel[0] === pi && edicion.sel[1] === ri && edicion.sel[2] === vi;

  function dibujarEdicion() {
    capaEdicion.clearLayers();
    const poly = L.polygon(aLatLng(), { color: '#E2B227', weight: 3, fillColor: '#E2B227', fillOpacity: .12, interactive: false });
    edicion.poly = poly; capaEdicion.addLayer(poly);
    edicion.partes.forEach((p, pi) => p.forEach((r, ri) => {
      r.forEach((c, vi) => {
        const d = r[(vi + 1) % r.length];
        const medio = [(c[0] + d[0]) / 2, (c[1] + d[1]) / 2];
        const mm = L.marker([medio[1], medio[0]], { draggable: true, icon: iconoMedio, zIndexOffset: 400 });
        let puesto = false;
        const insertar = () => { if (!puesto) { r.splice(vi + 1, 0, medio.slice()); puesto = true; } };
        mm.on('dragstart', insertar);
        mm.on('drag', e => { const ll = e.target.getLatLng(); r[vi + 1] = [ll.lng, ll.lat]; poly.setLatLngs(aLatLng()); });
        mm.on('dragend', () => { edicion.sel = [pi, ri, vi + 1]; dibujarEdicion(); });
        mm.on('click', () => { insertar(); edicion.sel = [pi, ri, vi + 1]; dibujarEdicion(); });
        capaEdicion.addLayer(mm);
      });
      r.forEach((c, vi) => {
        const m = L.marker([c[1], c[0]], { draggable: true, icon: iconoPunto(esSel(pi, ri, vi)), zIndexOffset: 1000 });
        m.on('drag', e => { const ll = e.target.getLatLng(); r[vi] = [ll.lng, ll.lat]; poly.setLatLngs(aLatLng()); });
        m.on('dragend', () => { edicion.sel = [pi, ri, vi]; dibujarEdicion(); });
        m.on('click', () => { edicion.sel = esSel(pi, ri, vi) ? null : [pi, ri, vi]; dibujarEdicion(); });
        capaEdicion.addLayer(m);
      });
    }));
    actualizarBarra();
  }

  function geometriaEditada() {
    const cerrar = r => r.concat([r[0].slice()]);
    const partes = edicion.partes.map(p => p.map(cerrar));
    return partes.length === 1 ? { type: 'Polygon', coordinates: partes[0] } : { type: 'MultiPolygon', coordinates: partes };
  }

  function actualizarBarra() {
    $('edArea').textContent = edicion.partes.length ? Motor.areaCompleta(Motor.areaGeo(geometriaEditada())).join('  |  ') : '';
    $('edBorrarPunto').disabled = !edicion.sel;
  }

  $('edBorrarPunto').onclick = () => {
    if (!edicion || !edicion.sel) return;
    const [pi, ri, vi] = edicion.sel;
    const r = edicion.partes[pi][ri];
    if (r.length > 3) r.splice(vi, 1);
    else if (ri > 0) { edicion.partes[pi].splice(ri, 1); avisar('Se quitó el hueco interior'); }
    else if (edicion.partes.length > 1) { edicion.partes.splice(pi, 1); avisar('Se quitó esa parte del polígono'); }
    else { avisar('Un polígono necesita al menos 3 puntos. Para quitarlo completo usa «Borrar polígono».'); return; }
    edicion.sel = null; dibujarEdicion();
  };

  function salirEdicion() {
    capaEdicion.clearLayers(); edicion = null;
    capaProblemas.addTo(mapa);
    $('barraEdicion').hidden = true; $('hoja').hidden = false;
  }
  $('edCancelar').onclick = () => { salirEdicion(); avisar('Edición cancelada'); };
  $('edGuardar').onclick = () => {
    const f = edicion.f, g = geometriaEditada();
    salirEdicion();
    guardarHistorial(); f.geometry = g; reanalizar(); avisar('Cambios guardados');
  };

  // ---------- Datos (atributos) ----------
  const NOMBRE_CAMPO = /^[A-Za-z_][A-Za-z0-9_]{0,9}$/;
  function camposDeCapa(id) {
    const c = [];
    estado.capa.features.forEach(f => { if ((f._capa || 0) === id) Object.keys(f.properties).forEach(k => { if (!c.includes(k)) c.push(k); }); });
    return c;
  }
  const vacio = v => v === null || v === undefined || String(v).trim() === '';

  function reetiquetar(id) {
    const capa = estado.capas[id];
    Motor.etiquetar(estado.capa.features.filter(f => (f._capa || 0) === id), capa.campoEtiqueta);
  }

  // si el campo editado sirve como nombre de la parcela, actualiza los nombres en pantalla
  function campoCambiado(id, campo) {
    const capa = estado.capas[id];
    if ((!capa.campoEtiqueta || Motor.ES_ID.test(capa.campoEtiqueta)) && /benef|nombre|propiet/i.test(campo)) capa.campoEtiqueta = campo;
    if (capa.campoEtiqueta === campo) { reetiquetar(id); renderProblemas(); }
  }

  function renderDatos() {
    if (!estado.capa) return;
    const selCapa = $('datosCapa'), selCampo = $('datosCampo');
    const capaAntes = selCapa.value;
    selCapa.innerHTML = estado.capas.map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('');
    if (capaAntes !== '' && estado.capas[+capaAntes]) selCapa.value = capaAntes;
    $('filaDatosCapa').hidden = estado.capas.length < 2;
    const id = +selCapa.value || 0;
    const campos = camposDeCapa(id);
    const campoAntes = selCampo.value;
    selCampo.innerHTML = campos.length ? campos.map(k => `<option>${esc(k)}</option>`).join('') : '<option value="">(sin campos)</option>';
    if (campos.includes(campoAntes)) selCampo.value = campoAntes;
    else { const b = campos.find(k => /benef/i.test(k)) || estado.capas[id].campoEtiqueta; if (b && campos.includes(b)) selCampo.value = b; }
    const campo = selCampo.value;
    const lista = $('datosLista'); lista.innerHTML = '';
    const feats = estado.capa.features.filter(f => (f._capa || 0) === id);
    if (!campo) { $('datosResumen').textContent = 'Esta capa no tiene campos. Agrega uno, por ejemplo BENEF.'; return; }
    const vacios = feats.filter(f => vacio(f.properties[campo]));
    $('datosResumen').textContent = vacios.length
      ? vacios.length + ' de ' + feats.length + ' polígonos no tienen dato en ' + campo + '.'
      : 'Los ' + feats.length + ' polígonos tienen dato en ' + campo + '.';
    const mostrar = $('soloVacios').checked ? vacios : feats.slice().sort((a, b) => vacio(b.properties[campo]) - vacio(a.properties[campo]));
    mostrar.slice(0, 400).forEach(f => {
      const fila = document.createElement('div'); fila.className = 'dato';
      fila.innerHTML = `<div class="dato-nombre"><b></b><span class="aviso"></span></div><div class="dato-editar"><input class="texto" autocomplete="off"><button class="boton">Ver</button></div>`;
      fila.querySelector('b').textContent = f._etiqueta;
      fila.querySelector('span').textContent = Motor.formatoArea(areaParcela(f));
      const inp = fila.querySelector('input');
      inp.value = vacio(f.properties[campo]) ? '' : f.properties[campo];
      inp.placeholder = 'Escribe ' + campo;
      const guardarValor = () => {
        const nuevo = inp.value.trim(), viejo = f.properties[campo];
        if (String(viejo == null ? '' : viejo) === nuevo) return;
        guardarHistorial();
        f.properties[campo] = nuevo;
        $('btnDeshacer').disabled = false;
        campoCambiado(id, campo);
        fila.querySelector('b').textContent = f._etiqueta;
        const nv = feats.filter(x => vacio(x.properties[campo])).length;
        $('datosResumen').textContent = nv ? nv + ' de ' + feats.length + ' polígonos no tienen dato en ' + campo + '.' : 'Los ' + feats.length + ' polígonos tienen dato en ' + campo + '.';
      };
      inp.onchange = guardarValor;
      inp.onkeydown = e => { if (e.key === 'Enter') { inp.blur(); const sig = fila.nextElementSibling; if (sig) sig.querySelector('input').focus(); } };
      fila.querySelector('button').onclick = () => verParcela(f);
      lista.appendChild(fila);
    });
    if (mostrar.length > 400) lista.insertAdjacentHTML('beforeend', '<p class="aviso">Se muestran los primeros 400.</p>');
  }
  $('datosCapa').onchange = () => { $('datosCampo').value = ''; renderDatos(); };
  $('datosCampo').onchange = renderDatos;
  $('soloVacios').onchange = renderDatos;

  function verParcela(f) {
    const l = L.geoJSON(f); const b = l.getBounds();
    if (b.isValid()) mapa.fitBounds(b, { paddingTopLeft: [30, 90], paddingBottomRight: [30, window.innerHeight * 0.48], maxZoom: 21 });
    const resaltado = L.geoJSON(f, { style: { color: '#E2B227', weight: 4, fillOpacity: 0 }, interactive: false }).addTo(mapa);
    setTimeout(() => mapa.removeLayer(resaltado), 2500);
  }

  function agregarCampo(id, nombre) {
    nombre = (nombre || '').trim();
    if (!NOMBRE_CAMPO.test(nombre)) { avisar('Usa hasta 10 letras, números o _ (sin espacios ni tildes), y que empiece con letra.'); return false; }
    if (camposDeCapa(id).some(k => k.toLowerCase() === nombre.toLowerCase())) { avisar('Ese campo ya existe.'); return false; }
    guardarHistorial();
    estado.capa.features.forEach(f => { if ((f._capa || 0) === id) f.properties[nombre] = ''; });
    $('btnDeshacer').disabled = false;
    campoCambiado(id, nombre);
    avisar('Campo ' + nombre + ' agregado');
    return true;
  }
  $('btnNuevoCampo').onclick = () => { $('nuevoCampoFila').hidden = false; $('nuevoCampo').focus(); };
  $('btnCrearCampo').onclick = () => {
    const id = +$('datosCapa').value || 0, nom = $('nuevoCampo').value;
    if (agregarCampo(id, nom)) {
      $('nuevoCampo').value = ''; $('nuevoCampoFila').hidden = true;
      renderDatos(); $('datosCampo').value = nom.trim(); renderDatos();
    }
  };

  // Formulario con todos los atributos de una parcela
  function formularioDatos(f) {
    const id = f._capa || 0;
    const campos = camposDeCapa(id);
    const caja = $('datosForm');
    caja.innerHTML = `<h2>${esc(f._etiqueta)}</h2>${estado.capas.length > 1 ? `<p class="aviso">Capa: ${esc(nombreCapa(f))}</p>` : ''}<div id="dfCampos"></div>
      <div class="fila"><input class="texto" id="dfNuevo" placeholder="Campo nuevo (ej. BENEF)" maxlength="10" autocomplete="off"><button class="boton" id="dfAgregar" style="flex:0 0 auto">Agregar campo</button></div>
      <div class="fila" style="margin-top:16px"><button class="boton" id="dfCancelar">Cancelar</button><button class="boton primario" id="dfGuardar">Guardar datos</button></div>`;
    const cont = caja.querySelector('#dfCampos');
    const pintar = lista => {
      cont.innerHTML = '';
      lista.forEach(k => {
        const lab = document.createElement('label'); lab.className = 'campo'; lab.textContent = k;
        const inp = document.createElement('input'); inp.className = 'texto'; inp.dataset.k = k; inp.autocomplete = 'off';
        inp.value = vacio(f.properties[k]) ? '' : f.properties[k];
        cont.appendChild(lab); cont.appendChild(inp);
      });
      if (!lista.length) cont.innerHTML = '<p class="aviso">Esta capa no tiene campos todavía.</p>';
    };
    pintar(campos);
    caja.querySelector('#dfAgregar').onclick = () => {
      const nom = caja.querySelector('#dfNuevo').value;
      // guarda primero lo escrito para no perderlo al redibujar
      const escrito = {}; cont.querySelectorAll('input').forEach(i => { escrito[i.dataset.k] = i.value; });
      if (agregarCampo(id, nom)) {
        caja.querySelector('#dfNuevo').value = '';
        pintar(camposDeCapa(id));
        cont.querySelectorAll('input').forEach(i => { if (i.dataset.k in escrito) i.value = escrito[i.dataset.k]; });
        const ult = cont.querySelector('input[data-k="' + nom.trim() + '"]'); if (ult) ult.focus();
      }
    };
    caja.querySelector('#dfCancelar').onclick = () => $('datosModal').classList.remove('abierto');
    caja.querySelector('#dfGuardar').onclick = () => {
      const cambios = {};
      cont.querySelectorAll('input').forEach(i => {
        const viejo = f.properties[i.dataset.k], nuevo = i.value.trim();
        if (String(viejo == null ? '' : viejo) !== nuevo) cambios[i.dataset.k] = nuevo;
      });
      $('datosModal').classList.remove('abierto');
      if (!Object.keys(cambios).length) return;
      guardarHistorial();
      Object.assign(f.properties, cambios);
      $('btnDeshacer').disabled = false;
      Object.keys(cambios).forEach(k => campoCambiado(id, k));
      if ($('pDatos').classList.contains('activo')) renderDatos();
      avisar('Datos guardados');
    };
    $('datosModal').classList.add('abierto');
  }

  // ---------- Hoja inferior ----------
  $('agarradera').onclick = () => {
    const h = $('hoja');
    h.className = h.classList.contains('mini') ? '' : (h.classList.contains('alta') ? 'mini' : 'alta');
  };
  function verPanel(id) {
    if (id === 'pDatos') renderDatos();
    document.querySelectorAll('.pestanas button').forEach(b => b.setAttribute('aria-selected', b.dataset.panel === id));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('activo', p.id === id));
    if (id === 'pClaude') renderChat();
  }
  document.querySelectorAll('.pestanas button').forEach(b => b.onclick = () => {
    verPanel(b.dataset.panel);
    if ($('hoja').classList.contains('mini')) $('hoja').className = '';
  });

  // ---------- Ajustes ----------
  function abrirAjustes() {
    $('ajClave').value = leerAjuste('clave', '');
    $('ajModelo').value = leerAjuste('modelo', MODELO_POR_DEFECTO);
    const o = opciones();
    $('ajTraslape').value = o.traslapeMin; $('ajArea').value = o.areaMin; $('ajHueco').value = o.huecoMax;
    $('ajustes').classList.add('abierto');
  }
  $('btnAjustes').onclick = abrirAjustes;
  $('btnIrAjustes').onclick = abrirAjustes;
  $('ajCancelar').onclick = () => $('ajustes').classList.remove('abierto');
  $('ajGuardar').onclick = () => {
    ponerAjuste('clave', $('ajClave').value.trim());
    ponerAjuste('modelo', $('ajModelo').value.trim() || MODELO_POR_DEFECTO);
    ponerAjuste('traslapeMin', $('ajTraslape').value || '1');
    ponerAjuste('areaMin', $('ajArea').value || '10');
    ponerAjuste('huecoMax', $('ajHueco').value || '2000');
    $('ajustes').classList.remove('abierto');
    if (estado.capa) reanalizar();
    renderChat();
    avisar('Ajustes guardados');
  };

  // ---------- Claude ----------
  const SISTEMA = `Eres un asistente dentro de una app Android que revisa y corrige polígonos de parcelas (reforestación y agroforestería en el altiplano de Guatemala). Hablas con técnicos de campo: responde en español sencillo, breve y concreto.

Recibes un resumen de la capa: parcelas con identificador (p1, p2…), nombre, área y atributos, y la lista de problemas que detectó la app. Las áreas están en m²; 1 cuerda = 628.86 m² (30 × 30 varas). Si te adjuntan un PDF (croquis, listado de beneficiarios, reporte de QGIS), úsalo como referencia.

Responde SOLO con un objeto JSON, sin texto antes ni después y sin bloques de código:
{"respuesta": "tu explicación", "acciones": [ ... ]}

Cada acción es una de estas:
{"tipo":"corregir","fid":"p4","motivo":"..."}  arregla una forma con error
{"tipo":"recortar","quitar_de":"p3","otro":"p1","motivo":"..."}  quita de p3 el área que se encima con p1
{"tipo":"rellenar","hueco":"hue-7","asignar_a":"p9","motivo":"..."}  une el hueco a la parcela indicada
{"tipo":"eliminar","fid":"p6","motivo":"..."}  borra un polígono (copias o astillas)

Usa solo identificadores que aparezcan en los datos. Propón una acción solo cuando haya una razón clara (por ejemplo, la parcela más grande suele ceder el área encimada pequeña, o el atributo de área registrada indica cuál está bien). Si decidir requiere saber algo del terreno que no está en los datos, dilo en la respuesta y no propongas acción para ese caso. Si solo te hacen una pregunta, deja "acciones" vacío.`;

  function datosParaClaude() {
    const ps = estado.analisis.problemas;
    const involucradas = new Set();
    ps.forEach(p => { [p.fid, p.fid2].concat(p.vecinos || []).filter(Boolean).forEach(u => involucradas.add(u)); });
    const parcelas = estado.capa.features.filter(f => involucradas.has(f._uid)).slice(0, 150).map(f => {
      const attrs = {};
      Object.keys(f.properties).slice(0, 8).forEach(k => { attrs[k] = String(f.properties[k] == null ? '' : f.properties[k]).slice(0, 40); });
      return { id: f._uid, nombre: f._etiqueta, capa: nombreCapa(f), area_m2: Math.round(areaParcela(f)), atributos: attrs };
    });
    const problemas = ps.slice(0, 100).map(p => {
      const o = { id: p.id, tipo: p.tipo };
      if (p.fid) o.parcela = p.fid; if (p.fid2) o.otra = p.fid2;
      if (p.area != null) o.area_m2 = Math.round(p.area * 10) / 10;
      if (p.motivo) o.motivo = p.motivo; if (p.vecinos) o.vecinos = p.vecinos;
      return o;
    });
    return {
      archivo: estado.nombre, capas: estado.capas.map(c => c.nombre), total_parcelas: estado.capa.features.length,
      campos: Object.keys((estado.capa.features[0] || {}).properties || {}),
      problemas, problemas_omitidos: Math.max(0, ps.length - 100), parcelas_involucradas: parcelas
    };
  }

  function renderChat() {
    const tieneClave = !!leerAjuste('clave', '');
    $('claudeSinClave').hidden = tieneClave; $('claudeConClave').hidden = !tieneClave;
    if (!tieneClave) return;
    const c = $('chat'); c.innerHTML = '';
    if (!estado.chat.length) {
      const m = document.createElement('div'); m.className = 'msg claude';
      m.textContent = estado.analisis && estado.analisis.total
        ? 'Puedo revisar los ' + estado.analisis.total + ' problemas y proponerte qué corregir. Tú decides qué aplicar.'
        : 'No hay problemas que revisar. Igual puedes preguntarme algo sobre la capa.';
      c.appendChild(m);
    }
    estado.chat.forEach((m, i) => {
      const el = document.createElement('div');
      el.className = 'msg ' + (m.rol === 'yo' ? 'yo' : (m.error ? 'error' : 'claude'));
      el.textContent = m.texto;
      if (m.acciones && m.acciones.length) {
        m.acciones.forEach((a, j) => {
          const box = document.createElement('div'); box.className = 'propuesta';
          box.innerHTML = `<p>${esc(describirAccion(a))}${a.motivo ? '. ' + esc(a.motivo) : ''}</p>`;
          if (a.hecho) box.innerHTML += `<span class="hecho">${esc(a.hecho)}</span>`;
          else {
            const b = document.createElement('button'); b.className = 'boton primario'; b.textContent = 'Aplicar';
            b.onclick = () => { const e = aplicar(a); a.hecho = e ? 'No se aplicó: ' + e : 'Aplicado'; renderChat(); };
            box.appendChild(b);
          }
          el.appendChild(box);
        });
        const pendientes = m.acciones.filter(a => !a.hecho);
        if (pendientes.length > 1) {
          const b = document.createElement('button'); b.className = 'boton primario'; b.style.marginTop = '8px';
          b.textContent = 'Aplicar las ' + pendientes.length;
          b.onclick = () => {
            let ok = 0;
            pendientes.forEach(a => { const e = aplicar(a, true); a.hecho = e ? 'No se aplicó: ' + e : 'Aplicado'; if (!e) ok++; });
            avisar(ok + ' de ' + pendientes.length + ' cambios aplicados'); renderChat();
          };
          el.appendChild(b);
        }
      }
      c.appendChild(el);
    });
    if (estado.cargandoClaude) { const p = document.createElement('div'); p.className = 'pensando'; p.textContent = 'Claude está revisando…'; c.appendChild(p); }
    $('pdfFicha').innerHTML = estado.pdf ? `<span class="ficha">📄 ${esc(estado.pdf.nombre)} <button aria-label="Quitar PDF" id="quitarPdf">×</button></span>` : '';
    if (estado.pdf) $('quitarPdf').onclick = () => { estado.pdf = null; renderChat(); };
    $('btnEnviar').disabled = estado.cargandoClaude;
    c.lastElementChild && c.lastElementChild.scrollIntoView({ block: 'end' });
  }

  function describirAccion(a) {
    switch (a.tipo) {
      case 'corregir': return 'Corregir la forma de ' + et(a.fid);
      case 'recortar': return 'Quitar de ' + et(a.quitar_de) + ' lo que se encima con ' + et(a.otro);
      case 'rellenar': return 'Unir el hueco a ' + et(a.asignar_a);
      case 'eliminar': return 'Borrar ' + et(a.fid);
    }
    return 'Acción desconocida';
  }

  document.querySelectorAll('#atajos button').forEach(b => b.onclick = () => preguntar(b.dataset.p));
  $('btnEnviar').onclick = () => { const t = $('pregunta').value.trim(); if (t) { $('pregunta').value = ''; preguntar(t); } };
  $('pregunta').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; });
  $('btnPdf').onclick = () => $('pdfArchivo').click();
  $('pdfArchivo').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!/\.pdf$/i.test(f.name)) { avisar('Elige un archivo PDF.'); return; }
    if (f.size > 20 * 1024 * 1024) { avisar('El PDF pesa más de 20 MB.'); return; }
    const b = new Uint8Array(await f.arrayBuffer());
    let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768));
    estado.pdf = { nombre: f.name, base64: btoa(s) };
    renderChat();
  };

  async function preguntar(texto) {
    if (estado.cargandoClaude || !estado.capa) return;
    const clave = leerAjuste('clave', '');
    if (!clave) { abrirAjustes(); return; }
    estado.chat.push({ rol: 'yo', texto });
    estado.cargandoClaude = true; renderChat();

    // Historial: las preguntas anteriores van solas; la última lleva los datos actuales y el PDF
    const mensajes = [];
    estado.chat.slice(0, -1).forEach(m => {
      if (m.error) return;
      mensajes.push({ role: m.rol === 'yo' ? 'user' : 'assistant', content: m.rol === 'yo' ? m.texto : JSON.stringify({ respuesta: m.texto, acciones: (m.acciones || []).map(a => ({ tipo: a.tipo, fid: a.fid, quitar_de: a.quitar_de, otro: a.otro, hueco: a.hueco, asignar_a: a.asignar_a })) }) });
    });
    const contenido = [];
    if (estado.pdf) contenido.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: estado.pdf.base64 } });
    contenido.push({ type: 'text', text: 'DATOS ACTUALES DE LA CAPA:\n' + JSON.stringify(datosParaClaude()) + '\n\nPREGUNTA:\n' + texto });
    mensajes.push({ role: 'user', content: contenido });
    // la API pide que los turnos alternen
    const limpios = [];
    mensajes.forEach(m => { if (limpios.length && limpios[limpios.length - 1].role === m.role) limpios.pop(); limpios.push(m); });

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-api-key': clave,
          'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({ model: leerAjuste('modelo', MODELO_POR_DEFECTO), max_tokens: 3000, system: SISTEMA, messages: limpios })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(mensajeError(r.status, data));
      const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      let resp;
      try {
        const limpio = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        const ini = limpio.indexOf('{'), fin = limpio.lastIndexOf('}');
        resp = JSON.parse(limpio.slice(ini, fin + 1));
      } catch (e) { resp = { respuesta: txt, acciones: [] }; }
      const validas = (resp.acciones || []).filter(accionValida);
      estado.chat.push({ rol: 'claude', texto: resp.respuesta || '(sin texto)', acciones: validas });
    } catch (e) {
      estado.chat.push({ rol: 'claude', error: true, texto: e.message === 'Failed to fetch' ? 'No hay conexión a internet. Las correcciones manuales siguen funcionando sin señal.' : e.message });
    } finally {
      estado.cargandoClaude = false; renderChat();
    }
  }

  function accionValida(a) {
    if (!a || typeof a !== 'object') return false;
    const existe = u => !!Motor.buscar(estado.capa, u);
    if (a.tipo === 'corregir' || a.tipo === 'eliminar') return existe(a.fid);
    if (a.tipo === 'recortar') return existe(a.quitar_de) && existe(a.otro) && a.quitar_de !== a.otro;
    if (a.tipo === 'rellenar') return existe(a.asignar_a) && !!estado.fotoProblemas[a.hueco];
    return false;
  }

  function mensajeError(status, data) {
    const m = data && data.error && data.error.message ? data.error.message : '';
    if (status === 401) return 'La clave de la API no es válida. Revísala en Ajustes.';
    if (status === 404) return 'No se encontró el modelo "' + leerAjuste('modelo', MODELO_POR_DEFECTO) + '". Cámbialo en Ajustes.';
    if (status === 429) return 'Demasiadas consultas seguidas. Espera un minuto y vuelve a intentar.';
    if (status === 400 && /credit/i.test(m)) return 'Tu cuenta de la API no tiene saldo. Recárgala en console.anthropic.com.';
    if (status === 529 || status >= 500) return 'El servicio de Claude está saturado. Intenta de nuevo en un momento.';
    return 'Error ' + status + (m ? ': ' + m : '');
  }

  // ---------- Guardar ----------
  function nombreSalida() { return ($('nombreSalida').value.trim() || 'corregido').replace(/[\\/:*?"<>|]/g, '_'); }

  async function guardarArchivo(nombre, datos, mime) {
    // datos: Uint8Array
    let s = ''; for (let i = 0; i < datos.length; i += 32768) s += String.fromCharCode.apply(null, datos.subarray(i, i + 32768));
    const b64 = btoa(s);
    if (window.Android && Android.guardarArchivo) {
      const r = Android.guardarArchivo(nombre, b64, mime);
      avisar(r);
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([datos], { type: mime })); a.download = nombre;
      document.body.appendChild(a); a.click(); a.remove();
      avisar('Guardado: ' + nombre);
    }
  }

  // Qué capa se guarda: una en particular o todas juntas (con un campo CAPA)
  function prepararSalida() {
    const sel = $('capaSalida');
    const antes = sel.value;
    sel.innerHTML = estado.capas.map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('') +
      (estado.capas.length > 1 ? '<option value="todas">Todas juntas (con campo CAPA)</option>' : '');
    if (antes && [...sel.options].some(o => o.value === antes)) sel.value = antes;
    $('filaCapaSalida').hidden = estado.capas.length < 2;
    cambiarSalida();
  }
  function cambiarSalida() {
    const v = $('capaSalida').value;
    const c = v === 'todas' ? null : estado.capas[+v];
    $('nombreSalida').value = (c ? c.nombre : 'capas_unidas') + '_corregido';
    const gtm = c ? c.esGTM : estado.capas.some(x => x.esGTM);
    $('crsSalida').value = gtm ? 'gtm' : 'wgs84';
    notaSalida();
  }
  function notaSalida() {
    const v = $('capaSalida').value;
    const c = v === 'todas' ? null : estado.capas[+v];
    const orig = c ? c.crs : estado.capas.map(x => x.crs).join(' / ');
    $('notaCrs').textContent = 'Original: ' + (orig || 'WGS84') + '. ' + ($('crsSalida').value === 'gtm'
      ? 'El shape se guarda en GTM. El GeoJSON siempre va en WGS84 (lo pide el formato).'
      : 'El shape se guarda en WGS84 (lat/long); QGIS lo reproyecta solo si tu proyecto está en GTM.');
  }
  $('crsSalida').onchange = notaSalida;
  $('capaSalida').onchange = cambiarSalida;
  function salida() {
    const v = $('capaSalida').value;
    if (v === 'todas') return { todas: true, features: estado.capa.features.map(f => Object.assign({}, f, { properties: Object.assign({ CAPA: nombreCapa(f) }, f.properties) })) };
    return { todas: false, capa: estado.capas[+v], features: estado.capa.features.filter(f => (f._capa || 0) === +v) };
  }

  // Arma un shape (en zip) a partir de una FeatureCollection y devuelve sus archivos
  async function archivosShape(fc, nom, gtm, tipo) {
    const types = tipo === 'puntos' ? { point: nom } : tipo === 'rutas' ? { polyline: nom, line: nom, linestring: nom, multiline: nom } : { polygon: nom, multipolygon: nom };
    const ab = await shpwrite.zip(fc, { outputType: 'arraybuffer', types });
    const zip = await JSZip.loadAsync(ab);
    zip.file(nom + '.cpg', 'ISO-8859-1');
    if (gtm) zip.file(nom + '.prj', Motor.GTM_WKT);
    const out = {};
    for (const n of Object.keys(zip.files)) if (!zip.files[n].dir) out[n.split('/').pop()] = await zip.file(n).async('uint8array');
    return out;
  }

  $('btnShape').onclick = async () => {
    if (!estado.capa || !salida().features.length) { avisar('No hay polígonos que guardar.'); return; }
    cargando(true, 'Preparando el shape…'); await esperar();
    try {
      const nom = nombreSalida();
      const gtm = $('crsSalida').value === 'gtm';
      const que = $('tipoShape').value;
      const sal = salida();
      const archivos = {};
      if (que === 'poligonos' || varias0(que)) {
        const fc = $('formatoFCA').checked ? shapeFormatoTabla(sal.features) : Motor.geojsonParaShape(sal);
        if (gtm) fc.features.forEach(f => { f.geometry = Motor.aGTM(f.geometry); });
        Object.assign(archivos, await archivosShape(fc, varias0(que) ? nom + '_poligonos' : nom, gtm, 'poligonos'));
      }
      const varias = que === 'ambos' || que === 'todo';
      if (que === 'puntos' || varias) {
        const fc = shapePuntos(sal.features, gtm);
        Object.assign(archivos, await archivosShape(fc, varias ? nom + '_puntos' : nom, gtm, 'puntos'));
      }
      if (que === 'rutas' || que === 'todo') {
        const fc = shapeRutas(sal.features, gtm);
        Object.assign(archivos, await archivosShape(fc, que === 'todo' ? nom + '_rutas' : nom, gtm, 'rutas'));
      }
      const zip = new JSZip();
      Object.keys(archivos).forEach(n => zip.file(n, archivos[n]));
      const final = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
      await guardarArchivo(nom + '.zip', final, 'application/zip');
    } catch (e) { avisar('No se pudo guardar: ' + e.message); } finally { cargando(false); }
  };

  function varias0(q) { return q === 'ambos' || q === 'todo'; }

  // Shape de rutas: una línea cerrada por cada parte del polígono, con Poli, begin y end
  // (begin/end son los números de vértice, iguales a la columna No. de la capa de puntos)
  function shapeRutas(feats, gtm) {
    const grupos = new Map();
    feats.forEach((f, i) => {
      const poli = valorCampo(f.properties, ['Poli']);
      const k = (f._capa || 0) + ':' + (poli === '' ? 'f' + i : poli);
      if (!grupos.has(k)) grupos.set(k, { poli: poli === '' ? f._num : poli, feats: [] });
      grupos.get(k).feats.push(f);
    });
    const lineas = [];
    [...grupos.values()].sort((a, b) => (+a.poli || 0) - (+b.poli || 0)).forEach(g => {
      let no = 0;
      g.feats.forEach(f => {
        const partes = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        partes.forEach(parte => {
          const anillo = parte[0] || [];
          if (anillo.length < 2) return;
          const ini = no + 1; no += anillo.length;
          lineas.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: anillo.map(c => gtm ? (Motor.ptoGTM([c[0], c[1]]) || c) : [c[0], c[1]]) },
            properties: { 'Poli': +g.poli || g.poli, 'begin': ini, 'end': no }
          });
        });
      });
    });
    return { type: 'FeatureCollection', features: lineas };
  }

  // Shape de puntos: un punto por vértice con los mismos campos de la tabla de reporte
  function shapePuntos(feats, gtm) {
    const grupos = new Map();
    feats.forEach((f, i) => {
      const poli = valorCampo(f.properties, ['Poli']);
      const k = (f._capa || 0) + ':' + (poli === '' ? 'f' + i : poli);
      if (!grupos.has(k)) grupos.set(k, { poli: poli === '' ? f._num : poli, feats: [] });
      grupos.get(k).feats.push(f);
    });
    const salidaPts = [];
    [...grupos.values()].sort((a, b) => (+a.poli || 0) - (+b.poli || 0)).forEach(g => {
      const p = g.feats[0].properties;
      const ha = Math.round(g.feats.reduce((s, f) => s + areaParcela(f), 0)) / 10000;
      const datos = {
        'Nombre': String(valorCampo(p, ['BENEF', 'Nombre', 'NOMBRE']) || g.feats[0]._etiqueta),
        'Sexo': String(valorCampo(p, ['SEXO', 'Sexo'])),
        'Indicador': String(valorCampo(p, ['INDICADOR', 'Indicador'])),
        'ESTATUS_l': String(valorCampo(p, ['ESTATUS', 'ESTATUS_l'])),
        'Observacio': String(valorCampo(p, ['MODALIDAD', 'Observacio', 'Observaciones'])),
        'Actividad/': String(valorCampo(p, ['ACTIVIDAD', 'Actividad'])),
        'Fecha de i': String(valorCampo(p, ['FECHA', 'Fecha de i', 'Fecha'])),
        'Área': ha
      };
      let no = 0;
      g.feats.forEach(f => {
        const partes = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        partes.forEach(parte => (parte[0] || []).forEach(c => {
          const xy = Motor.ptoGTM([c[0], c[1]]) || [c[0], c[1]];
          no++;
          salidaPts.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: gtm ? [xy[0], xy[1]] : [c[0], c[1]] },
            properties: Object.assign({ 'Poli': +g.poli || g.poli, 'No.': no, 'X': Math.round(xy[0] * 1000) / 1000, 'Y': Math.round(xy[1] * 1000) / 1000 }, datos)
          });
        }));
      });
    });
    return { type: 'FeatureCollection', features: salidaPts };
  }

  $('btnGeojson').onclick = async () => {
    if (!estado.capa || !salida().features.length) { avisar('No hay polígonos que guardar.'); return; }
    const texto = JSON.stringify(Motor.geojsonLimpio(salida()));
    await guardarArchivo(nombreSalida() + '.geojson', new TextEncoder().encode(texto), 'application/octet-stream');
  };

  // Busca el valor de un campo aceptando varios nombres posibles (el del shape o el del reporte)
  function valorCampo(p, nombres) {
    const claves = Object.keys(p);
    for (const n of nombres) {
      const k = claves.find(c => c.toLowerCase() === n.toLowerCase());
      if (k && p[k] != null && String(p[k]).trim() !== '') return p[k];
    }
    for (const n of nombres) {
      const k = claves.find(c => c.toLowerCase().startsWith(n.toLowerCase()));
      if (k && p[k] != null && String(p[k]).trim() !== '') return p[k];
    }
    return '';
  }
  // "28/04/2025" → fecha de Excel
  function fechaExcel(v) {
    const m = String(v).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (!m) return null;
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return (Date.UTC(y, +m[2] - 1, +m[1]) - Date.UTC(1899, 11, 30)) / 86400000;
  }

  // Shape con los campos de la tabla de reporte: un polígono por parcela, X/Y del centro en GTM y área en ha
  function shapeFormatoTabla(feats) {
    return {
      type: 'FeatureCollection',
      features: feats.map(f => {
        const p = f.properties;
        const c = Motor.centro(f.geometry);
        const xy = c ? (Motor.ptoGTM(c) || c) : ['', ''];
        const poli = valorCampo(p, ['Poli']);
        return {
          type: 'Feature',
          geometry: f.geometry.type === 'MultiPolygon' ? f.geometry : { type: 'MultiPolygon', coordinates: [f.geometry.coordinates] },
          properties: {
            'Poli': poli === '' ? f._num : (+poli || poli),
            'X': c ? Math.round(xy[0] * 1000) / 1000 : '',
            'Y': c ? Math.round(xy[1] * 1000) / 1000 : '',
            'Nombre': String(valorCampo(p, ['BENEF', 'Nombre', 'NOMBRE']) || f._etiqueta),
            'Sexo': String(valorCampo(p, ['SEXO', 'Sexo'])),
            'Indicador': String(valorCampo(p, ['INDICADOR', 'Indicador'])),
            'ESTATUS_l': String(valorCampo(p, ['ESTATUS', 'ESTATUS_l'])),
            'Observacio': String(valorCampo(p, ['MODALIDAD', 'Observacio', 'Observaciones'])),
            'Actividad/': String(valorCampo(p, ['ACTIVIDAD', 'Actividad'])),
            'Fecha de i': String(valorCampo(p, ['FECHA', 'Fecha de i', 'Fecha'])),
            'Área': Math.round(areaParcela(f)) / 10000
          }
        };
      })
    };
  }

  // Formato de puntos: Poli, No., X, Y (GTM) y los datos del beneficiario, repetidos en cada vértice
  function hojaPuntos(feats) {
    const enc = ['Poli', 'No.', 'X', 'Y', 'Nombre', 'Sexo', 'Indicador al que aporta', 'ESTATUS_l', 'Observaciones (modalidad)', 'Actividad/práctica que se realiza en el área', 'Fecha de incio de la práctica (día/mes/año)', 'Área'];
    const filas = [enc];
    const grupos = new Map();
    feats.forEach((f, i) => {
      const poli = valorCampo(f.properties, ['Poli']);
      const k = (f._capa || 0) + ':' + (poli === '' ? 'f' + i : poli);
      if (!grupos.has(k)) grupos.set(k, { poli: poli === '' ? f._num : poli, feats: [] });
      grupos.get(k).feats.push(f);
    });
    const orden = [...grupos.values()].sort((a, b) => (+a.poli || 0) - (+b.poli || 0));
    const fechas = [];
    orden.forEach(g => {
      const p = g.feats[0].properties;
      const ha = Math.round(g.feats.reduce((s, f) => s + areaParcela(f), 0)) / 10000;
      const datos = [
        valorCampo(p, ['BENEF', 'Nombre', 'NOMBRE']) || g.feats[0]._etiqueta,
        valorCampo(p, ['SEXO', 'Sexo']),
        valorCampo(p, ['INDICADOR', 'Indicador']),
        valorCampo(p, ['ESTATUS', 'ESTATUS_l']),
        valorCampo(p, ['MODALIDAD', 'Observacio', 'Observaciones']),
        valorCampo(p, ['ACTIVIDAD', 'Actividad']),
        valorCampo(p, ['FECHA', 'Fecha de i', 'Fecha'])
      ];
      let no = 0;
      g.feats.forEach(f => {
        const partes = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        partes.forEach(parte => {
          const anillo = parte[0] || [];
          anillo.forEach(c => {
            const xy = Motor.ptoGTM([c[0], c[1]]) || [c[0], c[1]];
            no++;
            const fila = [+g.poli || g.poli, no, Math.round(xy[0] * 1000) / 1000, Math.round(xy[1] * 1000) / 1000].concat(datos, [ha]);
            if (fechaExcel(datos[6]) != null) fechas.push(filas.length);
            filas.push(fila);
          });
        });
      });
    });
    const ws = XLSX.utils.aoa_to_sheet(filas);
    fechas.forEach(r => { const ref = 'K' + (r + 1); ws[ref] = { t: 'n', v: fechaExcel(ws[ref].v), z: 'dd/mm/yyyy' }; });
    for (let r = 1; r < filas.length; r++) {
      ['C', 'D'].forEach(c => { const x = ws[c + (r + 1)]; if (x) x.z = '0.000'; });
      ['L'].forEach(c => { const x = ws[c + (r + 1)]; if (x && x.t === 'n') x.z = '0.0000'; });
    }
    ws['!cols'] = [6, 5, 12, 12, 34, 10, 40, 11, 18, 30, 14, 9].map(w => ({ wch: w }));
    ws['!autofilter'] = { ref: 'A1:L' + filas.length };
    return ws;
  }

  // Excel: una fila por parcela con sus atributos, área y ubicación, más una hoja de problemas
  $('btnExcel').onclick = async () => {
    const sal = salida();
    if (!estado.capa || !sal.features.length) { avisar('No hay polígonos que guardar.'); return; }
    cargando(true, 'Preparando el Excel…'); await esperar();
    try {
      const feats = sal.features;
      const enSalida = new Set(feats.map(f => f._uid));
      const campos = [];
      feats.forEach(f => Object.keys(f.properties).forEach(k => { if (!campos.includes(k)) campos.push(k); }));
      const porParcela = {};
      estado.analisis.problemas.forEach(p => {
        const d = describir(p), txt = NOMBRES[p.tipo][0] + (p.tipo === 'invalida' ? ': ' + p.motivo : '');
        [p.fid, p.fid2].concat(p.vecinos || []).filter(Boolean).forEach(u => { (porParcela[u] = porParcela[u] || []).push(txt); });
      });
      const conEtiqueta = sal.todas || !sal.capa.campoEtiqueta;
      const enc = (conEtiqueta ? ['Parcela'] : []).concat(campos, ['Área (m²)', 'Cuerdas', 'Hectáreas', 'Latitud', 'Longitud', 'X (GTM)', 'Y (GTM)', 'Problemas pendientes']);
      const filas = [enc];
      feats.forEach(f => {
        const c = Motor.centro(f.geometry);
        filas.push((conEtiqueta ? [f._etiqueta] : []).concat(
          campos.map(k => { const v = f.properties[k]; return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v); }),
          [Math.round(areaParcela(f) * 100) / 100, null, null,
           c ? Math.round(c[1] * 1e6) / 1e6 : '', c ? Math.round(c[0] * 1e6) / 1e6 : '',
           ...(() => { const g = c ? Motor.ptoGTM(c) : null; return g ? [Math.round(g[0] * 100) / 100, Math.round(g[1] * 100) / 100] : ['', '']; })(),
           (porParcela[f._uid] || []).filter((t, i, a) => a.indexOf(t) === i).join('; ')]));
      });
      const ws = XLSX.utils.aoa_to_sheet(filas);
      // cuerdas y hectáreas como fórmulas a partir del área, y una fila de totales
      const colArea = campos.length + (conEtiqueta ? 1 : 0), colCu = colArea + 1, colHa = colArea + 2;
      const L = n => XLSX.utils.encode_col(n);
      for (let r = 1; r <= feats.length; r++) {
        const a = filas[r][colArea], ref = L(colArea) + (r + 1);
        ws[L(colCu) + (r + 1)] = { t: 'n', f: ref + '/628.86', v: Math.round(a / Motor.M2_POR_CUERDA * 100) / 100, z: '0.00' };
        ws[L(colHa) + (r + 1)] = { t: 'n', f: ref + '/10000', v: a / 10000, z: '0.0000' };
      }
      const ult = feats.length + 1, tot = ult + 1;
      const suma = (col, z) => ({ t: 'n', f: 'SUM(' + L(col) + '2:' + L(col) + ult + ')', z,
        v: filas.slice(1).reduce((s, f, i) => s + (col === colArea ? f[colArea] : col === colCu ? f[colArea] / Motor.M2_POR_CUERDA : f[colArea] / 10000), 0) });
      ws['A' + tot] = { t: 's', v: 'Total (' + feats.length + ' parcelas)' };
      ws[L(colArea) + tot] = suma(colArea, '#,##0.00'); ws[L(colCu) + tot] = suma(colCu, '0.00'); ws[L(colHa) + tot] = suma(colHa, '0.0000');
      ws['A' + (tot + 2)] = { t: 's', v: 'Áreas planas calculadas en proyección GTM (como en QGIS con una capa en GTM). 1 cuerda = 628.86 m² (30 × 30 varas de 0.8359 m).' };
      ws['!ref'] = 'A1:' + L(enc.length - 1) + (tot + 2);
      ws['!cols'] = enc.map((h, i) => ({ wch: i === 0 ? 22 : Math.min(40, Math.max(10, String(h).length + 2)) }));
      ws['!autofilter'] = { ref: 'A1:' + L(enc.length - 1) + ult };

      const wb = XLSX.utils.book_new();
      // Hoja 1: formato de puntos (una fila por vértice, como el reporte a FCA)
      XLSX.utils.book_append_sheet(wb, hojaPuntos(feats), 'Atributos');
      XLSX.utils.book_append_sheet(wb, ws, 'Resumen por parcela');
      const ps = estado.analisis.problemas.filter(p => [p.fid, p.fid2].concat(p.vecinos || []).some(u => enSalida.has(u))).map(p => { const d = describir(p); return [NOMBRES[p.tipo][0], d.que, d.detalle, p.area != null ? Math.round(p.area * 100) / 100 : '']; });
      const wp = XLSX.utils.aoa_to_sheet([['Tipo', 'Dónde', 'Detalle', 'Área (m²)']].concat(ps.length ? ps : [['Sin problemas pendientes', '', '', '']]));
      wp['!cols'] = [{ wch: 22 }, { wch: 34 }, { wch: 46 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, wp, 'Problemas');
      const datos = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      await guardarArchivo(nombreSalida() + '.xlsx', new Uint8Array(datos), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (e) { avisar('No se pudo crear el Excel: ' + e.message); } finally { cargando(false); }
  };

  // Tocar el mapa vacío cierra la selección
  mapa.on('click', () => { estado.sel = null; document.querySelectorAll('.problema.sel').forEach(e => e.classList.remove('sel')); });

  window.__app = { estado, abrir, aplicar, preguntar, editar };
})();
