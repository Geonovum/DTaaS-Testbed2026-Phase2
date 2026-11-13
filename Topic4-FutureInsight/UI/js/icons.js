// Small inline-SVG icon set, visually standing in for the Material icons used
// in the real app (not copied assets — plain redrawn line icons). Each icon is
// self-contained (explicit size/fill/stroke) so it renders correctly wherever
// it's dropped in; wrapping CSS can still override width/height for context.

function line(size, inner) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function solid(size, inner) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" stroke="none">${inner}</svg>`;
}

export const icons = {
  home: line(20, `<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/>`),
  hubs: line(20, `<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="18" r="2.4"/><path d="M12 7.4V13m0 0-5.5 3M12 13l5.5 3"/>`),
  recipes: line(20, `<path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 9.18 0A4 4 0 0 1 18 13.87V21H6z"/><path d="M6 17h12"/>`),
  digitalTwin: line(20, `<rect x="4" y="9" width="7" height="12"/><rect x="13" y="4" width="7" height="17"/><path d="M6 13h3M6 16h3M15 8h3M15 11h3M15 14h3"/>`),
  data: line(20, `<path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/>`),
  apps: line(20, `<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>`),
  connect: line(20, `<path d="m9 6-6 6 6 6M15 6l6 6-6 6"/>`),
  search: line(16, `<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>`),
  help: line(18, `<circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.3a2.7 2.7 0 1 1 3.9 2.4c-.9.5-1.2 1-1.2 2.1"/><circle cx="12" cy="17.2" r=".4" fill="currentColor"/>`),
  gear: line(18, `<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.7 7.7 0 0 0-1.7-1L15 3h-4l-.3 2.6a7.7 7.7 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.7 7.7 0 0 0 1.7 1L11 21h4l.3-2.6a7.7 7.7 0 0 0 1.7-1l2.4 1 2-3.4Z"/>`),
  globe: line(18, `<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.7 4 6 4 9.5s-1.4 6.8-4 9.5c-2.6-2.7-4-6-4-9.5s1.4-6.8 4-9.5Z"/>`),
  star: solid(18, `<path d="m12 2.5 3.1 6.3 7 1-5 4.9 1.2 7-6.3-3.3-6.3 3.3 1.2-7-5-4.9 7-1Z"/>`),
  chevronRight: line(16, `<path d="m9 5 7 7-7 7"/>`),
  chevronDown: line(16, `<path d="m5 9 7 7 7-7"/>`),
  play: solid(14, `<path d="M7 4.5v15l13-7.5Z"/>`),
  sort: line(16, `<path d="M7 4v16m0 0-3.5-3.5M7 20l3.5-3.5"/><path d="M17 20V4m0 0 3.5 3.5M17 4l-3.5 3.5"/>`),
  refresh: line(16, `<path d="M20 11a8 8 0 0 0-14.9-3.4M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.4M20 20v-5h-5"/>`),
  info: solid(14, `<circle cx="12" cy="12" r="10"/><rect x="10.8" y="10.5" width="2.4" height="7" fill="#fff"/><circle cx="12" cy="7.2" r="1.4" fill="#fff"/>`),
  eye: line(14, `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>`),
  lock: solid(13, `<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/>`),
  close: line(18, `<path d="M6 6l12 12M18 6 6 18"/>`),
  cart: line(18, `<circle cx="9" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="17" cy="20" r="1.4" fill="currentColor" stroke="none"/><path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L21 8H6"/>`),
  checkCircle: solid(16, `<circle cx="12" cy="12" r="10"/><path d="M8.3 12.3l2.6 2.6 5-5.2" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`),
  pencil: line(13, `<path d="M4 20l.9-4.2L15.6 5.1a1.5 1.5 0 0 1 2.1 0l1.2 1.2a1.5 1.5 0 0 1 0 2.1L8.2 19.1 4 20Z"/><path d="M14 6.5l3.5 3.5"/>`),
};
