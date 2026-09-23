/**
 * theme.js — dark / light theming for both the DOM and the map.
 *
 * The DOM side is a token swap in app.css, driven by `data-theme` on <html>.
 * The map side needs its own palette because MapLibre paint properties are not
 * CSS: basemap style URL, line colours, station and label colours all have to
 * be restated per theme.
 *
 * Line colours are darkened in light mode. BMRCL's official yellow is #FFDF00,
 * which on a pale basemap is essentially invisible — so the Yellow Line is
 * drawn at #8A6D00, and Purple and Green get deeper variants too, while
 * staying recognisably the same lines.
 */

const STORE_KEY = 'nml.theme';

export const MAP_THEMES = {
  dark: {
    id: 'dark',
    basemap: 'https://tiles.openfreemap.org/styles/dark',
    scrim: '#0a0f1a',
    // OpenFreeMap's dark style is already very dark; a heavy scrim on top made
    // streets and place names unreadable. Just enough wash to stop the basemap
    // competing with the metro lines.
    scrimOpacity: 0.20,
    casing: '#05070d',
    casingOpacity: 0.85,
    lineOpacity: 1,
    glowOpacity: 0.26,
    stationFill: '#0d1320',
    stationCore: '#ffffff',
    interchangeStroke: '#ffffff',
    label: '#eef3ff',
    labelHalo: '#040609',
    labelHaloWidth: 2.1,
    selRing: '#ffffff',
    trackRing: '#4da3ff',
    trackRingSoft: '#7fc0ff',
    trackLabel: '#bcdcff',
    trackLabelHalo: '#040609',
    lines: { PURPLE: '#B23C96', GREEN: '#18B94E', YELLOW: '#FFDF00' },
  },
  light: {
    id: 'light',
    // OpenFreeMap "liberty" is the standard, full-colour OSM-style basemap
    basemap: 'https://tiles.openfreemap.org/styles/liberty',
    // a white wash keeps the basemap legible without competing with the lines
    scrim: '#ffffff',
    scrimOpacity: 0.62,
    casing: '#ffffff',
    casingOpacity: 1,
    lineOpacity: 1,
    glowOpacity: 0.12,
    stationFill: '#ffffff',
    stationCore: '#111827',
    interchangeStroke: '#111827',
    label: '#16203a',
    labelHalo: '#ffffff',
    labelHaloWidth: 2.2,
    selRing: '#111827',
    trackRing: '#1565d8',
    trackRingSoft: '#3f86ec',
    trackLabel: '#0f4ea8',
    trackLabelHalo: '#ffffff',
    lines: { PURPLE: '#6B1457', GREEN: '#00631D', YELLOW: '#8A6D00' },
  },
};

/** Resolve the theme to start in: stored choice, else the OS preference. */
export function initialTheme() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* private mode */ }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(id) {
  document.documentElement.setAttribute('data-theme', id);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', id === 'light' ? '#eceff5' : '#0a0d14');
  try { localStorage.setItem(STORE_KEY, id); } catch { /* ignore */ }
}

export function mapTheme(id) {
  return MAP_THEMES[id] || MAP_THEMES.dark;
}

/** Line colour for a line id under a given theme, falling back to the feed colour. */
export function lineColor(themeId, lineId, fallback) {
  return mapTheme(themeId).lines[lineId] || fallback;
}
