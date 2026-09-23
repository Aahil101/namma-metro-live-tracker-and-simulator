/**
 * map-view.js — MapLibre scene: basemap, metro lines, stations, animated trains.
 *
 * Trains live in a single GeoJSON source that is rewritten on every animation
 * frame. That is the cheapest way to move ~60 symbols smoothly: MapLibre
 * re-uploads one small buffer instead of us juggling 60 DOM markers.
 *
 * MapLibre itself is loaded as a classic script from ./vendor (see index.html)
 * rather than imported. The UMD bundle is a single self-contained file with its
 * web worker inlined, which is what makes this site deployable as plain static
 * files with no build step and no CDN dependency at runtime.
 *
 * Theming: `setStyle()` discards every custom source and layer, so the whole
 * scene is built by `_buildScene()` and simply rebuilt after a theme switch.
 */

import { mapTheme } from './theme.js';
import { restrictionGeometry } from './maintenance.js';

const mlgl = globalThis.maplibregl;
if (!mlgl) {
  throw new Error('maplibre-gl failed to load — check that ./vendor/maplibre-gl.js is present');
}
const { Map: MlMap, NavigationControl, AttributionControl, Popup } = mlgl;

const BENGALURU = { center: [77.5905, 12.9655], zoom: 10.6 };

const WORLD = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] },
  }],
};

const EMPTY = { type: 'FeatureCollection', features: [] };

export class MetroMap {
  constructor(containerId, network, schedule, themeId = 'dark') {
    this.network = network;
    this.schedule = schedule;
    this.lineById = new Map(network.lines.map((l) => [l.id, l]));
    this.visibleLines = new Set(network.lines.map((l) => l.id));
    this.selectedTrain = null;
    this.followId = null;
    this.trackedId = null;
    this.trackedLabel = null;
    this.handlers = { station: [], train: [], userPan: [] };
    this.ready = false;
    this.themeId = themeId;
    this.t = mapTheme(themeId);
    this.lastTrains = [];

    this.map = new MlMap({
      container: containerId,
      style: this.t.basemap,
      center: BENGALURU.center,
      zoom: BENGALURU.zoom,
      minZoom: 8.5,
      maxZoom: 17.5,
      attributionControl: false,
      hash: false,
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 120,
    });

    this.map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    this.map.addControl(new AttributionControl({
      compact: true,
      customAttribution:
        'Timetable © <a href="https://www.bmrc.co.in" target="_blank" rel="noopener">BMRCL</a> · ' +
        'GTFS <a href="https://github.com/Vonter/bmrcl-gtfs" target="_blank" rel="noopener">Vonter/bmrcl-gtfs</a>',
    }), 'bottom-right');

    this.map.on('error', (e) => {
      // A failed basemap tile must not take the metro layers down with it.
      if (e?.error?.message) console.warn('[map]', e.error.message);
    });

    // Some upstream basemap styles reference sprite images they don't ship
    // (e.g. "wood-pattern"). Hand MapLibre a blank tile so it stops warning.
    this.map.on('styleimagemissing', (e) => {
      if (this.map.hasImage(e.id)) return;
      this.map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
  }

  /** Theme-aware colour for a line, used by the DOM panels too. */
  lineColor(lineId) {
    return this.t.lines[lineId] || this.lineById.get(lineId)?.color || '#888';
  }

  /** Resolves once layers are in place. */
  async init() {
    await this._waitForStyle(true);
    this._buildScene();
    this._wireInteractions();   // map-level listeners survive a style swap
    this.ready = true;
    return this;
  }

  on(event, fn) { this.handlers[event]?.push(fn); return this; }
  _emit(event, payload) { for (const fn of this.handlers[event] || []) fn(payload); }

  /**
   * Wait until the style is usable for addSource/addLayer.
   * `styledata` can fire slightly ahead of the style being complete, so poll
   * isStyleLoaded() as a backstop rather than trusting a single event.
   */
  async _waitForStyle(initial = false) {
    if (!this.map.isStyleLoaded()) {
      await new Promise((res) => {
        const done = () => res();
        this.map.once(initial ? 'load' : 'styledata', done);
        setTimeout(done, 8000); // never hang the UI on a slow style
      });
    }
    for (let i = 0; i < 60 && !this.map.isStyleLoaded(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Swap basemap + palette, then rebuild every custom layer. */
  async setTheme(themeId) {
    if (themeId === this.themeId) return;
    this.themeId = themeId;
    this.t = mapTheme(themeId);
    this.ready = false;

    // setStyle wipes sources, layers and images; the camera is preserved.
    this.map.setStyle(this.t.basemap);
    await this._waitForStyle(false);

    this._buildScene();
    this.ready = true;
    // put the fleet back immediately so there is no blank frame
    if (this.lastTrains.length) this.renderTrains(this.lastTrains, this.lastDescribe);
  }

  /* ------------------------------------------------------------------ *
   *  Scene construction (re-runnable)
   * ------------------------------------------------------------------ */

  _buildScene() {
    this._addIcons();
    this._addScrim();
    this._addLines();
    this._addMaintenance();
    this._addStations();
    this._addTrains();
    this._applyVisibility();
  }

  /** Canvas-drawn train symbols, one per line colour, per theme. */
  _addIcons() {
    for (const line of this.network.lines) {
      const name = `train-${line.id}`;
      if (this.map.hasImage(name)) this.map.removeImage(name);
      this.map.addImage(name, makeTrainIcon(this.lineColor(line.id), this.themeId), { pixelRatio: 2 });
    }
  }

  /** A translucent wash over the basemap so the metro lines read clearly. */
  _addScrim() {
    this.map.addSource('scrim', { type: 'geojson', data: WORLD });
    this.map.addLayer({
      id: 'scrim',
      type: 'fill',
      source: 'scrim',
      paint: { 'fill-color': this.t.scrim, 'fill-opacity': this.t.scrimOpacity },
    });
  }

  /**
   * One polyline per line, taken from the shape of that line's longest
   * end-to-end pattern (which by construction covers every station).
   */
  _addLines() {
    const features = [];
    for (const line of this.network.lines) {
      const pat = this.schedule.patterns
        .filter((p) => p.line === line.id)
        .sort((a, b) => b.stops.length - a.stops.length || a.dir - b.dir)[0];
      if (!pat) continue;
      const shape = this.network.shapes[pat.shape];
      if (!shape) continue;

      const coords = [];
      for (let i = 0; i < shape.coords.length; i += 2) coords.push([shape.coords[i], shape.coords[i + 1]]);

      features.push({
        type: 'Feature',
        properties: { line: line.id, color: this.lineColor(line.id), name: line.name },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }

    this.map.addSource('metro-lines', { type: 'geojson', data: { type: 'FeatureCollection', features } });

    this.map.addLayer({
      id: 'line-glow',
      type: 'line',
      source: 'metro-lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 9, 12, 16, 15, 26],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 9, 8, 15, 20],
        'line-opacity': this.t.glowOpacity,
      },
    });

    this.map.addLayer({
      id: 'line-casing',
      type: 'line',
      source: 'metro-lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': this.t.casing,
        'line-opacity': this.t.casingOpacity,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 5, 12, 8.5, 15, 14, 17, 20],
      },
    });

    this.map.addLayer({
      id: 'line-body',
      type: 'line',
      source: 'metro-lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.6, 12, 5, 15, 8.5, 17, 13],
        'line-opacity': this.t.lineOpacity,
      },
    });
  }

  /**
   * Hazard overlay on stretches under a speed restriction.
   *
   * Two complementary dashed layers (black `[2,2]`, yellow `[0,2,2]` so it
   * starts with a gap) sit on top of the line at about 60% of its width, so the
   * line colour still shows along both edges — green/yellow/black, which reads
   * as engineering works rather than as a third metro line.
   */
  _addMaintenance() {
    const sections = restrictionGeometry(this.network, this.schedule);
    const features = sections.map((s) => ({
      type: 'Feature',
      properties: {
        id: s.restriction.id,
        line: s.restriction.line,
        label: `${s.restriction.label}  ${s.restriction.maxSpeedKmh} km/h`,
        speed: s.restriction.maxSpeedKmh,
      },
      geometry: { type: 'LineString', coordinates: s.coords },
    }));

    this.maintenanceSections = sections;
    this.map.addSource('maintenance', { type: 'geojson', data: { type: 'FeatureCollection', features } });

    if (!features.length) return;

    const W = ['interpolate', ['linear'], ['zoom'], 9, 1.6, 12, 3.2, 15, 5.4, 17, 8];

    this.map.addLayer({
      id: 'maint-black',
      type: 'line',
      source: 'maintenance',
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#101215',
        'line-width': W,
        'line-dasharray': [2, 2],
      },
    });

    this.map.addLayer({
      id: 'maint-yellow',
      type: 'line',
      source: 'maintenance',
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#FFD21E',
        'line-width': W,
        // leading zero-length dash shifts the pattern into the black gaps
        'line-dasharray': [0, 2, 2],
      },
    });

    this.map.addLayer({
      id: 'maint-label',
      type: 'symbol',
      source: 'maintenance',
      layout: {
        'symbol-placement': 'line-center',
        'text-field': ['get', 'label'],
        'text-font': ['literal', ['Noto Sans Bold']],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 9, 13, 11, 16, 13],
        'text-offset': [0, 1.6],
        'text-letter-spacing': 0.08,
        'text-allow-overlap': false,
        'text-padding': 2,
      },
      paint: {
        'text-color': '#FFD21E',
        'text-halo-color': this.themeId === 'light' ? '#ffffff' : '#101215',
        'text-halo-width': 2.2,
      },
    });
  }

  _addStations() {
    const features = [];
    for (const [id, st] of Object.entries(this.network.stations)) {
      if (!st.lines.length) continue;
      const interchange = st.lines.length > 1;
      features.push({
        type: 'Feature',
        properties: {
          id, name: st.name, code: st.code,
          lines: st.lines.join(','),
          color: this.lineColor(st.lines[0]),
          interchange,
          sort: interchange ? 0 : 5,
        },
        geometry: { type: 'Point', coordinates: [st.lon, st.lat] },
      });
    }
    this.map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features }, promoteId: 'id' });

    this.map.addLayer({
      id: 'station-halo',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          10, ['case', ['get', 'interchange'], 5.5, 3.2],
          13, ['case', ['get', 'interchange'], 9, 5.5],
          16, ['case', ['get', 'interchange'], 15, 10]],
        'circle-color': this.t.stationFill,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 13, 2.2, 16, 3],
        'circle-stroke-color': ['case', ['get', 'interchange'], this.t.interchangeStroke, ['get', 'color']],
        'circle-opacity': 0.95,
      },
    });

    this.map.addLayer({
      id: 'station-core',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          11, ['case', ['get', 'interchange'], 2.6, 0],
          16, ['case', ['get', 'interchange'], 6.5, 3]],
        'circle-color': this.t.stationCore,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0, 12.5, 1],
      },
    });

    this.map.addLayer({
      id: 'station-hit',
      type: 'circle',
      source: 'stations',
      paint: { 'circle-radius': 15, 'circle-color': '#000', 'circle-opacity': 0 },
    });

    this.map.addLayer({
      id: 'station-label',
      type: 'symbol',
      source: 'stations',
      layout: {
        'text-field': ['get', 'name'],
        // OpenFreeMap only hosts Noto Sans Regular / Bold / Italic — asking for
        // anything else 404s every glyph range and forces local fallback text.
        'text-font': [
          'case',
          ['get', 'interchange'], ['literal', ['Noto Sans Bold']],
          ['literal', ['Noto Sans Regular']],
        ],
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 14, 11.5, 16, 13.5],
        'text-offset': [0, 1.25],
        'text-anchor': 'top',
        'text-max-width': 9,
        'text-padding': 3,
        'symbol-sort-key': ['get', 'sort'],
        'text-optional': true,
      },
      paint: {
        'text-color': this.t.label,
        'text-halo-color': this.t.labelHalo,
        'text-halo-width': this.t.labelHaloWidth,
        'text-halo-blur': 0.4,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 10.4, 0, 11.4, 1],
      },
    });
  }

  _addTrains() {
    this.map.addSource('trains', { type: 'geojson', data: EMPTY });
    this.map.addSource('train-sel', { type: 'geojson', data: EMPTY });
    this.map.addSource('train-tracked', { type: 'geojson', data: EMPTY });

    // expanding ring around a friend's shared train
    this.map.addLayer({
      id: 'train-tracked-pulse',
      type: 'circle',
      source: 'train-tracked',
      paint: {
        'circle-radius': 14,
        'circle-color': this.t.trackRing,
        'circle-opacity': 0.18,
        'circle-stroke-width': 2,
        'circle-stroke-color': this.t.trackRingSoft,
        'circle-stroke-opacity': 0.8,
      },
    });

    this.map.addLayer({
      id: 'train-tracked-core',
      type: 'circle',
      source: 'train-tracked',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 11, 14, 17, 17, 25],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 2.5,
        'circle-stroke-color': this.t.trackRing,
        'circle-stroke-opacity': 0.95,
      },
    });

    this.map.addLayer({
      id: 'train-sel-ring',
      type: 'circle',
      source: 'train-sel',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 13, 14, 22, 17, 34],
        'circle-color': this.t.selRing,
        'circle-opacity': 0.14,
        'circle-stroke-width': 2,
        'circle-stroke-color': this.t.selRing,
        'circle-stroke-opacity': 0.75,
      },
    });

    this.map.addLayer({
      id: 'train-glow',
      type: 'circle',
      source: 'trains',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4.5, 12, 8, 15, 14, 17, 20],
        'circle-color': ['get', 'color'],
        'circle-blur': 0.85,
        'circle-opacity': ['case', ['get', 'dim'], 0.12, this.themeId === 'light' ? 0.35 : 0.55],
      },
    });

    this.map.addLayer({
      id: 'train-icon',
      type: 'symbol',
      source: 'trains',
      layout: {
        'icon-image': ['concat', 'train-', ['get', 'line']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.42, 11.5, 0.6, 14, 0.9, 17, 1.25],
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-opacity': [
          'case',
          ['get', 'dim'], 0.22,
          ['==', ['get', 'status'], 'moving'], 1,
          0.82,
        ],
      },
    });

    this.map.addLayer({
      id: 'train-tracked-label',
      type: 'symbol',
      source: 'train-tracked',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['literal', ['Noto Sans Bold']],
        'text-size': 11,
        'text-offset': [0, -2.1],
        'text-anchor': 'bottom',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': this.t.trackLabel,
        'text-halo-color': this.t.trackLabelHalo,
        'text-halo-width': 2,
      },
    });

    this.map.addLayer({
      id: 'train-hit',
      type: 'circle',
      source: 'trains',
      paint: { 'circle-radius': 13, 'circle-color': '#000', 'circle-opacity': 0 },
    });
  }

  /* ------------------------------------------------------------------ *
   *  Interaction
   * ------------------------------------------------------------------ */

  _wireInteractions() {
    const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 14, maxWidth: '260px' });
    this.popup = popup;

    for (const layer of ['train-hit', 'station-hit']) {
      this.map.on('mouseenter', layer, () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', layer, () => {
        this.map.getCanvas().style.cursor = '';
        popup.remove();
      });
    }

    this.map.on('mousemove', 'station-hit', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const st = this.network.stations[f.properties.id];
      if (!st) return;
      const chips = st.lines.map((l) => {
        const c = this.lineColor(l);
        return `<span class="pill" style="background:${c};color:${pickText(c)}">${this.lineById.get(l)?.name ?? l}</span>`;
      }).join('');
      popup.setLngLat([st.lon, st.lat])
        .setHTML(`<div class="pop-name">${esc(st.name)}</div><div class="pop-lines">${chips}</div>`)
        .addTo(this.map);
    });

    this.map.on('mousemove', 'train-hit', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties;
      popup.setLngLat(f.geometry.coordinates)
        .setHTML(
          `<div class="pop-name">${esc(p.run)} → ${esc(p.headsign)}</div>` +
          `<div style="color:var(--txt-2);font-size:.73rem;margin-top:2px">${esc(p.sub)}</div>`
        )
        .addTo(this.map);
    });

    this.map.on('click', 'station-hit', (e) => {
      e.originalEvent.stopPropagation();
      this._emit('station', e.features[0].properties.id);
    });

    this.map.on('click', 'train-hit', (e) => {
      e.originalEvent.stopPropagation();
      this._emit('train', e.features[0].properties.id);
    });

    for (const ev of ['dragstart', 'zoomstart', 'rotatestart']) {
      this.map.on(ev, (e) => {
        if (e.originalEvent && this.followId) this._emit('userPan');
      });
    }
  }

  /* ------------------------------------------------------------------ *
   *  Per-frame update
   * ------------------------------------------------------------------ */

  renderTrains(trains, describe) {
    this.lastTrains = trains;
    this.lastDescribe = describe;
    if (!this.ready) return;

    const features = [];
    let sel = null;
    let tracked = null;
    const trackedId = this.trackedId;

    for (const t of trains) {
      if (!this.visibleLines.has(t.line)) continue;
      const isTracked = trackedId != null && t.id === trackedId;
      const f = {
        type: 'Feature',
        properties: {
          id: t.id,
          line: t.line,
          color: this.lineColor(t.line),
          bearing: t.bearing,
          status: t.status,
          run: t.run,
          headsign: t.headsign,
          sub: describe ? describe(t) : '',
          dim: trackedId != null && !isTracked,
        },
        geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
      };
      features.push(f);
      if (t.id === this.selectedTrain) sel = f;
      if (isTracked) {
        tracked = {
          type: 'Feature',
          properties: { label: this.trackedLabel || 'tracked' },
          geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
        };
      }
    }

    this.map.getSource('trains')?.setData({ type: 'FeatureCollection', features });
    this.map.getSource('train-sel')?.setData({ type: 'FeatureCollection', features: sel ? [sel] : [] });
    this.map.getSource('train-tracked')?.setData({ type: 'FeatureCollection', features: tracked ? [tracked] : [] });

    if (tracked) {
      const phase = (performance.now() % 1800) / 1800;
      const base = 11 + Math.max(0, this.map.getZoom() - 10) * 2.2;
      this.map.setPaintProperty('train-tracked-pulse', 'circle-radius', base + phase * base * 1.5);
      this.map.setPaintProperty('train-tracked-pulse', 'circle-stroke-opacity', 0.85 * (1 - phase));
      this.map.setPaintProperty('train-tracked-pulse', 'circle-opacity', 0.2 * (1 - phase));
    }

    if (this.followId && sel) this.map.jumpTo({ center: sel.geometry.coordinates });
  }

  setTracked(id, label) {
    this.trackedId = id;
    this.trackedLabel = label;
    if (!id && this.ready) {
      this.map.getSource('train-tracked')?.setData(EMPTY);
    }
  }

  setLineVisible(lineId, visible) {
    if (visible) this.visibleLines.add(lineId);
    else this.visibleLines.delete(lineId);
    this._applyVisibility();
  }

  _applyVisibility() {
    if (!this.map.getLayer('line-body')) return;
    const filter = ['in', ['get', 'line'], ['literal', [...this.visibleLines]]];
    for (const id of ['line-casing', 'line-body', 'line-glow']) this.map.setFilter(id, filter);
    for (const id of ['maint-black', 'maint-yellow', 'maint-label']) {
      if (this.map.getLayer(id)) this.map.setFilter(id, filter);
    }

    const stationFilter = ['any', ...[...this.visibleLines].map((l) => ['in', l, ['get', 'lines']])];
    for (const id of ['station-halo', 'station-core', 'station-label', 'station-hit']) {
      this.map.setFilter(id, this.visibleLines.size ? stationFilter : ['==', ['get', 'id'], '__none__']);
    }
  }

  selectTrain(id) { this.selectedTrain = id; }
  setFollow(id) { this.followId = id; }

  flyToStation(stationId, zoom = 14.2) {
    const st = this.network.stations[stationId];
    if (!st) return;
    this.map.flyTo({ center: [st.lon, st.lat], zoom: Math.max(this.map.getZoom(), zoom), duration: 900, essential: true });
  }

  flyToTrain(train, zoom = 14) {
    this.map.flyTo({ center: [train.lon, train.lat], zoom: Math.max(this.map.getZoom(), zoom), duration: 800, essential: true });
  }

  resetView() {
    this.map.flyTo({ ...BENGALURU, duration: 900, essential: true });
  }
}

/* ==================================================================== *
 *  Icon factory
 * ==================================================================== */

/**
 * Draws a small train pointing north (bearing 0), so MapLibre's `icon-rotate`
 * can aim it along the track. On the light theme the outline is darkened and
 * the glazing tinted down, otherwise the icon dissolves into a pale basemap.
 */
function makeTrainIcon(color, themeId = 'dark') {
  const W = 22, H = 38, S = 2; // logical size, 2× for retina
  const c = document.createElement('canvas');
  c.width = W * S; c.height = H * S;
  const g = c.getContext('2d');
  g.scale(S, S);

  const light = themeId === 'light';
  const outline = light ? shade(color, -0.72) : shade(color, -0.55);
  const glass = light ? 'rgba(232,242,255,.95)' : 'rgba(210,232,255,.92)';
  const lamp = mix(color, '#ffffff', light ? 0.55 : 0.72);

  g.beginPath();
  roundRectPath(g, 3, 2, W - 6, H - 4, [7, 7, 4, 4]);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = light ? 2 : 1.6;
  g.strokeStyle = outline;
  g.stroke();

  g.beginPath();
  roundRectPath(g, 6, 5.5, W - 12, 7.5, 3);
  g.fillStyle = glass;
  g.fill();

  g.fillStyle = light ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.34)';
  g.fillRect(5.5, 17, 2.2, 12);
  g.fillRect(W - 7.7, 17, 2.2, 12);

  g.fillStyle = lamp;
  g.beginPath(); g.arc(7.5, 4.6, 1.15, 0, 7); g.fill();
  g.beginPath(); g.arc(W - 7.5, 4.6, 1.15, 0, 7); g.fill();

  g.fillStyle = light ? 'rgba(190,30,30,.9)' : 'rgba(255,90,90,.85)';
  g.fillRect(8, H - 5.4, W - 16, 1.8);

  const data = g.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: data.data };
}

function roundRectPath(g, x, y, w, h, r) {
  const [tl, tr, br, bl] = Array.isArray(r) ? r : [r, r, r, r];
  g.moveTo(x + tl, y);
  g.lineTo(x + w - tr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + tr);
  g.lineTo(x + w, y + h - br);
  g.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  g.lineTo(x + bl, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - bl);
  g.lineTo(x, y + tl);
  g.quadraticCurveTo(x, y, x + tl, y);
  g.closePath();
}

/* ------------------------------ colour utils ------------------------ */

function hex2rgb(h) {
  const s = h.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const rgb2hex = (r, g, b) => '#' + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('');

function shade(hex, amt) {
  const [r, g, b] = hex2rgb(hex);
  const f = amt < 0 ? 1 + amt : 1;
  const add = amt > 0 ? 255 * amt : 0;
  return rgb2hex(r * f + add, g * f + add, b * f + add);
}
function mix(a, b, t) {
  const [r1, g1, b1] = hex2rgb(a), [r2, g2, b2] = hex2rgb(b);
  return rgb2hex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

/** Black or white text, whichever contrasts better — matters for the yellow line. */
export function pickText(hex) {
  const [r, g, b] = hex2rgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#12151d' : '#ffffff';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export { esc };
