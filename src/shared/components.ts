/**
 * Animated CSS components (MEDIA-05, MEDIA-06; plan §6.3). Pure and DOM-free:
 * used by the browser (dialog, rendering) and the server (validation, MCP).
 *
 * Presets are templates written by us: their parameters are typed and
 * checked, text is HTML-escaped and colours must be hex, so no free text ever
 * reaches CSS. Custom content is size-limited and refused when it holds
 * obvious bad content (the first of three layers: this check, the sanitiser
 * and the CSS filter in the browser, and a sandboxed frame without scripts).
 */
import { isColor } from "./limits";

export const COMPONENT_LIMITS = {
  /** custom HTML and CSS, each, in UTF-8 bytes */
  contentBytes: 20 * 1024,
  title: 200,
  textParam: 200,
} as const;

export type ParamValue = string | number;

export interface PresetParam {
  name: string;
  type: "color" | "text" | "number" | "choice";
  default: ParamValue;
  description: string;
  min?: number;
  max?: number;
  choices?: readonly string[];
}

export interface PresetDef {
  name: PresetName;
  title: string;
  description: string;
  params: readonly PresetParam[];
  /** default size on the board */
  width: number;
  height: number;
}

export const PRESET_NAMES = [
  "pulse",
  "spinner",
  "typing-dots",
  "progress-bar",
  "shimmer-card",
  "marquee",
  "bounce-arrow",
  "gradient-wave",
] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

const color = (name: string, def: string, description = "Colour (hex)"): PresetParam => ({
  name,
  type: "color",
  default: def,
  description,
});
const speed = (def: number): PresetParam => ({
  name: "speed",
  type: "number",
  default: def,
  min: 0.2,
  max: 10,
  description: "Seconds per cycle (0.2-10)",
});

export const PRESETS: readonly PresetDef[] = [
  {
    name: "pulse",
    title: "Pulse dot",
    description: "A dot with a ring that pulses outwards (status, live, attention).",
    params: [color("color", "#007f78"), speed(1.6)],
    width: 120,
    height: 120,
  },
  {
    name: "spinner",
    title: "Spinner",
    description: "A spinning loading ring.",
    params: [color("color", "#007f78"), speed(1)],
    width: 120,
    height: 120,
  },
  {
    name: "typing-dots",
    title: "Typing dots",
    description: "Three dots bouncing in turn, like someone typing.",
    params: [color("color", "#193a36"), speed(1.2)],
    width: 160,
    height: 80,
  },
  {
    name: "progress-bar",
    title: "Progress bar",
    description: "A bar filled to a value with a moving sheen and an optional label.",
    params: [
      { name: "value", type: "number", default: 60, min: 0, max: 100, description: "0-100" },
      color("color", "#007f78"),
      { name: "label", type: "text", default: "", description: "Text above the bar" },
    ],
    width: 320,
    height: 80,
  },
  {
    name: "shimmer-card",
    title: "Shimmer card",
    description: "A loading placeholder card with shimmering lines.",
    params: [
      {
        name: "lines",
        type: "number",
        default: 3,
        min: 1,
        max: 8,
        description: "Number of lines (1-8)",
      },
    ],
    width: 320,
    height: 160,
  },
  {
    name: "marquee",
    title: "Moving text",
    description: "Text that scrolls across from right to left.",
    params: [
      { name: "text", type: "text", default: "Hello from ChalanaMaya", description: "The text" },
      color("color", "#193a36"),
      speed(8),
    ],
    width: 360,
    height: 60,
  },
  {
    name: "bounce-arrow",
    title: "Bouncing arrow",
    description: "An arrow that bounces in its direction (look here, next step).",
    params: [
      {
        name: "direction",
        type: "choice",
        default: "down",
        choices: ["up", "down", "left", "right"],
        description: "up, down, left or right",
      },
      color("color", "#b65b24"),
    ],
    width: 100,
    height: 100,
  },
  {
    name: "gradient-wave",
    title: "Colour wave",
    description: "A soft wave of two colours moving across.",
    params: [
      color("from", "#bfe8e2", "First colour (hex)"),
      color("to", "#c9dcf5", "Second colour (hex)"),
      speed(6),
    ],
    width: 320,
    height: 180,
  },
];

export const presetByName = (name: string): PresetDef | undefined =>
  PRESETS.find((p) => p.name === name);

export type ComponentSource =
  | { kind: "preset"; preset: PresetName; params: Record<string, ParamValue> }
  | { kind: "custom"; html: string; css: string };

/** Checks preset parameters: known names, right types and ranges. Returns an error or null. */
export const checkPresetParams = (
  preset: string,
  params: unknown,
): { path: string; reason: string } | null => {
  const def = presetByName(preset);
  if (!def) return { path: "preset", reason: `must be one of ${PRESET_NAMES.join(", ")}` };
  if (typeof params !== "object" || params === null || Array.isArray(params))
    return { path: "params", reason: "must be an object" };
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    const p = def.params.find((x) => x.name === k);
    const path = `params.${k}`;
    if (!p)
      return {
        path,
        reason: `is not a parameter of ${preset} (it has ${def.params.map((x) => x.name).join(", ")})`,
      };
    if (p.type === "color" && !isColor(v))
      return { path, reason: "must be a lower-case #hex colour" };
    if (p.type === "text" && (typeof v !== "string" || v.length > COMPONENT_LIMITS.textParam))
      return { path, reason: `must be text of at most ${COMPONENT_LIMITS.textParam} characters` };
    if (
      p.type === "number" &&
      (typeof v !== "number" || !Number.isFinite(v) || v < p.min! || v > p.max!)
    )
      return { path, reason: `must be a number from ${p.min} to ${p.max}` };
    if (p.type === "choice" && !p.choices!.includes(v as string))
      return { path, reason: `must be one of ${p.choices!.join(", ")}` };
  }
  return null;
};

/** The parameters with defaults filled in. */
export const presetValues = (preset: PresetDef, params: Record<string, ParamValue>) => {
  const out: Record<string, ParamValue> = {};
  for (const p of preset.params) out[p.name] = params[p.name] ?? p.default;
  return out;
};

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const num = (v: ParamValue) => String(Number(v));

/** Builds a preset's HTML and CSS (our own markup; parameters already checked). */
export const renderPreset = (
  name: string,
  params: Record<string, ParamValue>,
): { html: string; css: string } => {
  const def = presetByName(name) ?? PRESETS[0];
  const v = presetValues(def, params);
  const c = String(v.color ?? "#007f78");
  const s = num(v.speed ?? 1);
  const base =
    "html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;overflow:hidden;font-family:system-ui,sans-serif}";
  switch (def.name) {
    case "pulse":
      return {
        html: '<div class="p"><span class="dot"></span><span class="ring"></span></div>',
        css: `${base}.p{position:relative;width:40%;aspect-ratio:1}.dot,.ring{position:absolute;inset:25%;border-radius:50%;background:${c}}.ring{inset:25%;background:transparent;border:3px solid ${c};animation:pulse ${s}s ease-out infinite}@keyframes pulse{from{transform:scale(1);opacity:1}to{transform:scale(2.2);opacity:0}}`,
      };
    case "spinner":
      return {
        html: '<div class="s"></div>',
        css: `${base}.s{width:50%;aspect-ratio:1;border-radius:50%;border:6px solid ${c}33;border-top-color:${c};animation:spin ${s}s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`,
      };
    case "typing-dots":
      return {
        html: '<div class="t"><i></i><i></i><i></i></div>',
        css: `${base}.t{display:flex;gap:12%;width:60%;justify-content:center}.t i{width:18%;aspect-ratio:1;border-radius:50%;background:${c};animation:bob ${s}s ease-in-out infinite}.t i:nth-child(2){animation-delay:${Number(s) / 6}s}.t i:nth-child(3){animation-delay:${Number(s) / 3}s}@keyframes bob{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-60%);opacity:1}}`,
      };
    case "progress-bar": {
      const label = String(v.label ?? "");
      return {
        html: `<div class="w">${label ? `<div class="l">${escapeHtml(label)}</div>` : ""}<div class="b"><div class="f"></div></div></div>`,
        css: `${base}.w{width:88%}.l{font-size:14px;color:#193a36;margin-bottom:6px}.b{height:14px;border-radius:7px;background:#e3ebe9;overflow:hidden}.f{height:100%;width:${num(v.value ?? 0)}%;border-radius:7px;background:${c};background-image:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);background-size:50% 100%;background-repeat:no-repeat;animation:sheen 1.6s linear infinite}@keyframes sheen{from{background-position:-100% 0}to{background-position:200% 0}}`,
      };
    }
    case "shimmer-card": {
      const lines = Math.round(Number(v.lines ?? 3));
      return {
        html: `<div class="c"><div class="h"></div>${'<div class="ln"></div>'.repeat(lines)}</div>`,
        css: `${base}.c{width:90%;padding:6%;box-sizing:border-box;border-radius:12px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.12)}.h,.ln{height:12px;margin:8px 0;border-radius:6px;background:linear-gradient(90deg,#e8eeec 25%,#f6f9f8 50%,#e8eeec 75%);background-size:200% 100%;animation:sh 1.4s linear infinite}.h{width:45%;height:16px}.ln:last-child{width:70%}@keyframes sh{from{background-position:200% 0}to{background-position:-200% 0}}`,
      };
    }
    case "marquee":
      return {
        html: `<div class="m"><span>${escapeHtml(String(v.text ?? ""))}</span></div>`,
        css: `${base}.m{width:100%;overflow:hidden;white-space:nowrap}.m span{display:inline-block;padding-left:100%;font-size:22px;color:${c};animation:mq ${s}s linear infinite}@keyframes mq{to{transform:translateX(-100%)}}`,
      };
    case "bounce-arrow": {
      const dir = String(v.direction ?? "down");
      const rot = { up: 180, down: 0, left: 90, right: -90 }[dir] ?? 0;
      const axis = dir === "left" || dir === "right" ? "X" : "Y";
      const sign = dir === "up" || dir === "left" ? -1 : 1;
      return {
        html: '<svg class="a" viewBox="0 0 40 40"><path d="M20 6v24M10 20l10 10 10-10" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
        css: `${base}.a{width:60%;height:60%;stroke:${c};transform:rotate(${rot}deg);animation:bn 1s ease-in-out infinite}@keyframes bn{0%,100%{translate:0 0}50%{translate:${axis === "X" ? `${sign * 15}%` : "0"} ${axis === "Y" ? `${sign * 15}%` : "0"}}}`,
      };
    }
    case "gradient-wave":
      return {
        html: '<div class="g"></div>',
        css: `${base}.g{position:absolute;inset:0;background:linear-gradient(120deg,${String(v.from)},${String(v.to)},${String(v.from)},${String(v.to)});background-size:300% 300%;animation:wv ${s}s ease-in-out infinite}@keyframes wv{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}`,
      };
  }
};

/** A data: picture that components may use in `url()` and `<img src>`. */
export const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i;

const utf8Bytes = (s: string) => {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
};

/** Decodes CSS escapes (`\75 rl(` is `url(`), so checks see what a browser sees. */
export const decodeCssEscapes = (css: string) =>
  css.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f0-9a-fA-F]))/g, (_m, hex, ch) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
        ? String.fromCodePoint(cp)
        : "\ufffd";
    }
    return ch as string;
  });

/** Every url(...) target in decoded CSS text. */
const cssUrls = (css: string) => {
  const out: string[] = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
  for (let m = re.exec(css); m; m = re.exec(css)) out.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
  return out;
};

export interface ContentRule {
  rule: string;
  message: string;
}

const HTML_RULES: { re: RegExp; rule: string; message: string }[] = [
  { re: /<\s*script/i, rule: "no_scripts", message: "Scripts (<script>) are not allowed." },
  {
    re: /<[^>]*\s(?:on[a-z]+)\s*=/i,
    rule: "no_event_attributes",
    message: "Event attributes such as onclick or onerror are not allowed.",
  },
  {
    re: /(?:java|vb)script\s*:/i,
    rule: "no_javascript_links",
    message: "javascript: links are not allowed.",
  },
  {
    re: /<\s*(?:iframe|frame|frameset|object|embed|applet|portal)\b/i,
    rule: "no_frames",
    message: "Frames and embedded objects (<iframe>, <object>, <embed>) are not allowed.",
  },
  { re: /<\s*form\b/i, rule: "no_forms", message: "Forms are not allowed." },
  {
    re: /<\s*(?:meta|link|base)\b/i,
    rule: "no_meta_tags",
    message: "<meta>, <link> and <base> tags are not allowed.",
  },
  {
    re: /<\s*style\b/i,
    rule: "no_style_in_html",
    message: "Put CSS in the CSS box, not in a <style> element.",
  },
  {
    re: /<\s*foreignObject\b/i,
    rule: "no_foreign_object",
    message: "SVG <foreignObject> is not allowed.",
  },
];

const checkCss = (css: string, where: string): ContentRule | null => {
  const d = decodeCssEscapes(css);
  if (/@import/i.test(d))
    return { rule: "no_import", message: `${where}: @import is not allowed.` };
  if (/<\/?\s*style/i.test(d))
    return { rule: "no_style_close", message: `${where}: "</style" is not allowed.` };
  if (/expression\s*\(|behavior\s*:|-moz-binding/i.test(d))
    return {
      rule: "no_css_scripts",
      message: `${where}: expression(), behavior and -moz-binding are not allowed.`,
    };
  if (/(?:java|vb)script\s*:/i.test(d))
    return { rule: "no_javascript_links", message: `${where}: javascript: links are not allowed.` };
  for (const u of cssUrls(d))
    if (!DATA_IMAGE_RE.test(u))
      return {
        rule: "no_outside_resources",
        message: `${where}: url() may only hold a data:image/png, jpeg, gif or webp picture; nothing can be loaded from the internet.`,
      };
  if (/\b(?:image-set|src)\s*\(/i.test(d))
    return {
      rule: "no_outside_resources",
      message: `${where}: image-set() and src() are not allowed; use url() with a data: picture.`,
    };
  return null;
};

/**
 * The server-side content check for custom components: sizes, then the
 * obvious forbidden content, with a message naming the rule. The same
 * function backs the UI dialog, so both say the same thing.
 */
export const checkCustomContent = (
  html: string,
  css: string,
): ({ field: "html" | "css" } & ContentRule) | null => {
  const max = COMPONENT_LIMITS.contentBytes;
  if (utf8Bytes(html) > max)
    return { field: "html", rule: "too_large", message: `HTML must be at most ${max / 1024} KB.` };
  if (utf8Bytes(css) > max)
    return { field: "css", rule: "too_large", message: `CSS must be at most ${max / 1024} KB.` };
  for (const r of HTML_RULES)
    if (r.re.test(html)) return { field: "html", rule: r.rule, message: r.message };
  // src/href in the HTML may only be data: pictures (there is nothing to link to)
  const attr =
    /\s(?:src|href|xlink:href|srcset|action|formaction|poster|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = attr.exec(html); m; m = attr.exec(html)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!DATA_IMAGE_RE.test(v))
      return {
        field: "html",
        rule: "no_outside_resources",
        message:
          "src and href may only hold a data:image/png, jpeg, gif or webp picture; nothing can be loaded from the internet.",
      };
  }
  const inline = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (let m = inline.exec(html); m; m = inline.exec(html)) {
    const bad = checkCss(m[1] ?? m[2] ?? "", "A style attribute");
    if (bad) return { field: "html", ...bad };
  }
  const bad = checkCss(css, "CSS");
  return bad ? { field: "css", ...bad } : null;
};

/** The rules, for the dialog and the docs. */
export const COMPONENT_RULES = [
  `HTML and CSS: at most ${COMPONENT_LIMITS.contentBytes / 1024} KB each.`,
  "No scripts, event attributes (onclick, onerror…) or javascript: links.",
  "No frames, objects, embeds, forms, <meta>, <link>, <base> or <style> in the HTML.",
  "Nothing from the internet: url(), src and href may only hold data: pictures (PNG, JPEG, GIF, WebP); no @import.",
  "Components are look-only: they cannot be clicked, open windows or change the board.",
] as const;

/** Checks a stored `source` object strictly (no defaults, no changes). */
export const checkComponentSource = (src: unknown): { path: string; reason: string } | null => {
  if (typeof src !== "object" || src === null || Array.isArray(src))
    return { path: "source", reason: "must be {kind: preset|custom, …}" };
  const o = src as Record<string, unknown>;
  const keys = Object.keys(o);
  if (o.kind === "preset") {
    for (const k of keys)
      if (!["kind", "preset", "params"].includes(k))
        return { path: `source.${k}`, reason: "is not a known field" };
    if (typeof o.preset !== "string") return { path: "source.preset", reason: "is missing" };
    const e = checkPresetParams(o.preset, o.params);
    return e ? { path: `source.${e.path}`, reason: e.reason } : null;
  }
  if (o.kind === "custom") {
    for (const k of keys)
      if (!["kind", "html", "css"].includes(k))
        return { path: `source.${k}`, reason: "is not a known field" };
    if (typeof o.html !== "string") return { path: "source.html", reason: "must be text" };
    if (typeof o.css !== "string") return { path: "source.css", reason: "must be text" };
    const bad = checkCustomContent(o.html, o.css);
    return bad ? { path: `source.${bad.field}`, reason: `${bad.message} (${bad.rule})` } : null;
  }
  return { path: "source.kind", reason: "must be preset or custom" };
};
