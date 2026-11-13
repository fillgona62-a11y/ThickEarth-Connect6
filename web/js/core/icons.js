/**
 * Inline icon set. Every icon is a 24x24 stroke SVG rendered with
 * currentColor so seats, links, and buttons can theme them freely.
 */
import { s } from './dom.js';

const ICON_PATHS = {
  home: [['path', { d: 'M3 10.5 12 3l9 7.5' }], ['path', { d: 'M5 9.5V21h14V9.5' }], ['path', { d: 'M9.5 21v-6h5v6' }]],
  swords: [['path', { d: 'm4 4 6.5 6.5M20 4l-6.5 6.5' }], ['path', { d: 'M3 21l4-1 1-4-4 1z' }], ['path', { d: 'M21 21l-4-1-1-4 4 1z' }], ['path', { d: 'm8 16 8-8M16 16 8 8' }]],
  users: [['circle', { cx: 9, cy: 8, r: 3.2 }], ['path', { d: 'M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5' }], ['path', { d: 'M16 5.5c1.6.4 2.6 1.6 2.6 3.2S17.6 11.5 16 12' }], ['path', { d: 'M17.5 15.4c2 .6 3.2 2.2 3.2 4.6' }]],
  cpu: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }], ['path', { d: 'M9.5 9.5h5v5h-5z' }], ['path', { d: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M18 9h3M3 15h3M18 15h3' }]],
  user: [['circle', { cx: 12, cy: 8, r: 3.5 }], ['path', { d: 'M5 20.5c.6-3.5 3.4-5.6 7-5.6s6.4 2.1 7 5.6' }]],
  globe: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M3.5 12h17M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5z' }]],
  settings: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M19.4 13.4a7.7 7.7 0 0 0 0-2.8l1.8-1.2-2-3.4-2.1.8a7.6 7.6 0 0 0-2.4-1.4L14.3 3h-4l-.4 2.4a7.6 7.6 0 0 0-2.4 1.4l-2.1-.8-2 3.4 1.8 1.2a7.7 7.7 0 0 0 0 2.8l-1.8 1.2 2 3.4 2.1-.8a7.6 7.6 0 0 0 2.4 1.4l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.4-1.4l2.1.8 2-3.4z' }]],
  book: [['path', { d: 'M4 4.5A1.5 1.5 0 0 1 5.5 3H20v16H5.5A1.5 1.5 0 0 0 4 20.5z' }], ['path', { d: 'M4 20.5A1.5 1.5 0 0 1 5.5 19H20v2H5.5' }], ['path', { d: 'M8 7.5h8M8 11h5' }]],
  chart: [['path', { d: 'M4 20V4' }], ['path', { d: 'M4 20h16' }], ['path', { d: 'M8 16v-4M12 16V8M16 16v-6M20 16v-2' }]],
  history: [['path', { d: 'M3.5 12a8.5 8.5 0 1 0 2.9-6.4' }], ['path', { d: 'M3 3v5h5' }], ['path', { d: 'M12 7.5V12l3 2' }]],
  play: [['path', { d: 'M7 4.5 19.5 12 7 19.5z' }]],
  pause: [['path', { d: 'M8 4.5v15M16 4.5v15' }]],
  prev: [['path', { d: 'M18 5.5v13L8.5 12z' }], ['path', { d: 'M5 4.5v15' }]],
  next: [['path', { d: 'M6 5.5v13L15.5 12z' }], ['path', { d: 'M19 4.5v15' }]],
  first: [['path', { d: 'M7 5.5v13L17 12z' }], ['path', { d: 'M20.5 5v14' }]],
  last: [['path', { d: 'M17 5.5v13L7 12z' }], ['path', { d: 'M3.5 5v14' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  minus: [['path', { d: 'M5 12h14' }]],
  arrowRight: [['path', { d: 'M4 12h16M14 6l6 6-6 6' }]],
  arrowLeft: [['path', { d: 'M20 12H4M10 6l-6 6 6 6' }]],
  download: [['path', { d: 'M12 3.5v11M7.5 10.5 12 15l4.5-4.5' }], ['path', { d: 'M4.5 17.5v2a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-2' }]],
  upload: [['path', { d: 'M12 15V4M7.5 8.5 12 4l4.5 4.5' }], ['path', { d: 'M4.5 17.5v2a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-2' }]],
  trash: [['path', { d: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13' }], ['path', { d: 'M10 11v5M14 11v5' }]],
  copy: [['rect', { x: 8.5, y: 8.5, width: 11, height: 11, rx: 2 }], ['path', { d: 'M15.5 8.5v-3a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3' }]],
  check: [['path', { d: 'm4.5 12.5 5 5 10-11' }]],
  x: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  alert: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.5v5M12 16.2v.3' }]],
  info: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 11v5M12 7.8v.3' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7v5.2l3.4 2' }]],
  trophy: [['path', { d: 'M8 4h8v4.5a4 4 0 0 1-8 0z' }], ['path', { d: 'M8 5.5H4.5V8a3.5 3.5 0 0 0 3.5 3.5M16 5.5h3.5V8a3.5 3.5 0 0 1-3.5 3.5' }], ['path', { d: 'M12 12.5V17M8.5 20.5h7l-.8-3.5H9.3z' }]],
  flag: [['path', { d: 'M6 21V4' }], ['path', { d: 'M6 4h11l-2 4 2 4H6' }]],
  // A solid disc reads as "one stone" at 14px, where a flag outline collapsed into a "P".
  stone: [['circle', { cx: 12, cy: 12, r: 6.5, fill: 'currentColor', stroke: 'none' }]],
  grid: [['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 2 }], ['path', { d: 'M3.5 9h17M3.5 15h17M9 3.5v17M15 3.5v17' }]],
  layers: [['path', { d: 'm12 3 8.5 4.5L12 12 3.5 7.5z' }], ['path', { d: 'm3.5 12 8.5 4.5 8.5-4.5' }], ['path', { d: 'm3.5 16.5 8.5 4.5 8.5-4.5' }]],
  share: [['circle', { cx: 6, cy: 12, r: 2.5 }], ['circle', { cx: 18, cy: 6, r: 2.5 }], ['circle', { cx: 18, cy: 18, r: 2.5 }], ['path', { d: 'm8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6' }]],
  refresh: [['path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.5-6' }], ['path', { d: 'M20.5 3.5V9H15' }]],
  eye: [['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }], ['circle', { cx: 12, cy: 12, r: 3.2 }]],
  eyeOff: [['path', { d: 'M3 3l18 18' }], ['path', { d: 'M10.5 6.1A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.3 3.8M6.3 7.4A16.6 16.6 0 0 0 2.5 12S6 18 12 18a9.7 9.7 0 0 0 3.4-.6' }], ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2' }]],
  seat: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['circle', { cx: 12, cy: 12, r: 3.5 }]],
  link: [['path', { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 7' }], ['path', { d: 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7L12.5 17' }]],
  logout: [['path', { d: 'M15 4.5h3.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H15' }], ['path', { d: 'M10 12h10M16 8l4 4-4 4' }]],
  activity: [['path', { d: 'M3 12h4l2.5-7 4 14 2.5-7H21' }]],
  sparkle: [['path', { d: 'M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18l-1.8-5.4L4.5 10.8 10.2 9z' }], ['path', { d: 'M19 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z' }]],
  compass: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'm15.5 8.5-2 5-5 2 2-5z' }]],
  shield: [['path', { d: 'M12 3.5 19 6v5.5c0 4.2-2.9 7.3-7 9-4.1-1.7-7-4.8-7-9V6z' }], ['path', { d: 'm9 12 2 2 4-4' }]],
  lock: [['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' }]],
  mail: [['rect', { x: 3.5, y: 5.5, width: 17, height: 13, rx: 2 }], ['path', { d: 'm4 7 8 6 8-6' }]],
  menu: [['path', { d: 'M4 7h16M4 12h16M4 17h16' }]],
  chevronDown: [['path', { d: 'm6 9 6 6 6-6' }]],
  chevronRight: [['path', { d: 'm9 6 6 6-6 6' }]],
  chevronLeft: [['path', { d: 'm15 6-6 6 6 6' }]],
  skip: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  message: [['path', { d: 'M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 3v-3a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 4 5.5z' }], ['path', { d: 'M8 10h8M8 13.5h5' }]],
  send: [['path', { d: 'M3.5 11.5 21 3l-4.5 18-4.2-7.2L3.5 11.5z' }], ['path', { d: 'M21 3 12.3 13.8' }]],
  key: [['circle', { cx: 8, cy: 12, r: 3.5 }], ['path', { d: 'M11.5 12H21M18 12v3.5M15 12v2.5' }]],
  plug: [['path', { d: 'M9 3v5M15 3v5' }], ['path', { d: 'M6.5 8h11v4a5.5 5.5 0 0 1-11 0z' }], ['path', { d: 'M12 17.5V21' }]],
  robot: [['rect', { x: 5, y: 8, width: 14, height: 11, rx: 2.5 }], ['path', { d: 'M12 4.5v3.5M9 3.5h6' }], ['circle', { cx: 9.5, cy: 13, r: 1.2 }], ['circle', { cx: 14.5, cy: 13, r: 1.2 }], ['path', { d: 'M9 16h6M3.5 12v3M20.5 12v3' }]]
};

export function icon(name, size) {
  const paths = ICON_PATHS[name] || ICON_PATHS.info;
  const element = s('svg', {
    viewBox: '0 0 24 24',
    width: size || 18,
    height: size || 18,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.7,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false'
  });
  for (const [tag, attrs] of paths) element.appendChild(s(tag, attrs));
  return element;
}

export function iconButton(name, label, attrs) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn';
  button.setAttribute('aria-label', label);
  button.title = label;
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      if (key === 'class') button.className = button.className + ' ' + attrs[key];
      else if (key.slice(0, 2) === 'on' && typeof attrs[key] === 'function') button.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
      else button.setAttribute(key, attrs[key]);
    }
  }
  button.appendChild(icon(name, 18));
  return button;
}
