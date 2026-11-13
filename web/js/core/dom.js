/**
 * Minimal DOM construction helpers.
 *
 * The UI builds DOM nodes directly instead of using innerHTML so that player
 * supplied strings are always inserted as text. Static trusted markup may use
 * the html attribute, which is only used for generated icon/illustration SVG.
 */

function appendChild(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const item of child) appendChild(parent, item);
    return;
  }
  if (child instanceof Node) {
    parent.appendChild(child);
    return;
  }
  parent.appendChild(document.createTextNode(String(child)));
}

export function h(tag, attrs, ...children) {
  const element = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') element.className = value;
      else if (key === 'dataset') Object.assign(element.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
      else if (key === 'html') element.innerHTML = value;
      else if (key === 'text') element.textContent = value;
      else if (key === 'ref' && typeof value === 'function') value(element);
      else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) {
        element.setAttribute(key, '');
      } else {
        element.setAttribute(key, String(value));
      }
    }
  }
  appendChild(element, children);
  return element;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(tag, attrs, ...children) {
  const element = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') element.setAttribute('class', value);
      else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        element.setAttribute(key, String(value));
      }
    }
  }
  appendChild(element, children);
  return element;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(parent, child) {
  clear(parent);
  if (child !== null && child !== undefined) parent.appendChild(child);
  return parent;
}

export function text(value) {
  return document.createTextNode(value === null || value === undefined ? '' : String(value));
}

export function qs(selector, root) {
  return (root || document).querySelector(selector);
}

export function qsa(selector, root) {
  return Array.from((root || document).querySelectorAll(selector));
}

export function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
}

/**
 * Render a list with stable keys. Callers pass a key function used to reuse
 * existing DOM nodes so live updates (SSE) do not destroy focus.
 */
export function keyedList(parent, items, keyOf, render) {
  const existing = new Map();
  for (const child of Array.from(parent.children)) {
    const key = child.dataset && child.dataset.key;
    if (key !== undefined) existing.set(key, child);
  }
  const used = new Set();
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const key = String(keyOf(item));
    used.add(key);
    let node = existing.get(key);
    if (node) {
      const replacement = render(item, node);
      if (replacement && replacement !== node) {
        existing.delete(key);
        node = replacement;
      }
    } else {
      node = render(item, null);
    }
    if (node) {
      node.dataset.key = key;
      fragment.appendChild(node);
    }
  }
  for (const [key, node] of existing) {
    if (!used.has(key)) node.remove();
  }
  parent.appendChild(fragment);
  return parent;
}

export function focusFirst(container) {
  const target = container.querySelector('[autofocus], input, button, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (target && typeof target.focus === 'function') target.focus();
}
