/**
 * The fixed srcdoc shell for components (plan §6.3). The CSP <meta> is the
 * first element in <head>; then the base reset and paused rule, then the
 * user CSS after the CSS filter, then the user HTML after DOMPurify. The
 * frame holding it has sandbox="" (no scripts, no same origin).
 */
import type { DOMPurify as Purifier } from "dompurify";
import {
  DATA_IMAGE_RE,
  decodeCssEscapes,
  renderPreset,
  type ComponentSource,
} from "../shared/components";

export const COMPONENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

const ALLOWED_TAGS = [
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "small",
  "mark",
  "sub",
  "sup",
  "br",
  "hr",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "figure",
  "figcaption",
  "blockquote",
  "code",
  "pre",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "img",
  "label",
  "progress",
  "meter",
  "svg",
  "g",
  "path",
  "circle",
  "rect",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "animate",
  "animatetransform",
];
const ALLOWED_ATTR = [
  "class",
  "id",
  "style",
  "role",
  "title",
  "alt",
  "src",
  "width",
  "height",
  "value",
  "max",
  "min",
  "viewbox",
  "d",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "fill-opacity",
  "stroke-opacity",
  "opacity",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "transform",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "preserveaspectratio",
  "clip-path",
  "mask",
  "font-size",
  "font-family",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "attributename",
  "from",
  "to",
  "values",
  "dur",
  "repeatcount",
  "begin",
  "type",
  "colspan",
  "rowspan",
];

/**
 * The CSS filter: decodes escapes, drops comments, @import, @namespace,
 * @charset, expression(), behavior, -moz-binding, javascript: and every
 * url() that is not a data: picture, and escapes "<" so nothing can close
 * the <style> element.
 */
export const filterCss = (css: string): string => {
  let s = decodeCssEscapes(css).replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
  s = s.replace(/@(?:import|namespace|charset)\b[^;{}]*(?:;|(?=[{}])|$)/gi, "");
  s = s.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (m, a, b, c) =>
    DATA_IMAGE_RE.test(String(a ?? b ?? c ?? "").trim()) ? m : "none",
  );
  s = s.replace(/\b(?:image-set|src)\s*\(/gi, "none(");
  s = s.replace(/expression\s*\(/gi, "none(");
  s = s.replace(/behavior\s*:|-moz-binding|(?:java|vb)script\s*:/gi, "x-blocked:");
  // fonts may only come from data: (the CSP holds this too); drop other @font-face blocks
  s = s.replace(/@font-face\s*\{[^}]*\}/gi, (m) => (/url\(\s*['"]?data:font\//i.test(m) ? m : ""));
  // no absolute addresses at all (the CSP blocks loads too)
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\//gi, "blocked:");
  return s.replace(/</g, "\\3c ");
};

let hooked = new WeakSet<Purifier>();
const hook = (purify: Purifier) => {
  if (hooked.has(purify)) return;
  hooked.add(purify);
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName === "style") data.attrValue = filterCss(data.attrValue);
    else if (data.attrName === "src" && !DATA_IMAGE_RE.test(data.attrValue.trim()))
      data.keepAttr = false;
  });
};

/** Sanitises component HTML with an explicit allow-list. */
export const sanitizeHtml = (purify: Purifier, html: string): string => {
  hook(purify);
  return purify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: [
      "style",
      "link",
      "meta",
      "base",
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "foreignobject",
      "a",
      "use",
      "image",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    WHOLE_DOCUMENT: false,
    RETURN_TRUSTED_TYPE: false,
  }) as string;
};

const BASE_CSS =
  "*,*::before,*::after{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#193a36;font-family:system-ui,sans-serif}";
const PAUSED_CSS =
  "*,*::before,*::after{animation-play-state:paused!important;transition:none!important}";

/** The whole srcdoc for one component. */
export const buildComponentDoc = (
  purify: Purifier,
  source: ComponentSource,
  paused: boolean,
): string => {
  const { html, css } =
    source.kind === "preset" ? renderPreset(source.preset, source.params) : source;
  return (
    "<!doctype html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="${COMPONENT_CSP}">` +
    '<meta charset="utf-8">' +
    `<style>${BASE_CSS}${paused ? PAUSED_CSS : ""}</style>` +
    `<style>${filterCss(css)}</style>` +
    `</head><body>${sanitizeHtml(purify, html)}</body></html>`
  );
};

/** for tests: forget hooked instances */
export const resetComponentDocHooks = () => {
  hooked = new WeakSet();
};
