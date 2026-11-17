const SAFE_SCHEMES = ["http:", "https:", "mailto:"];

/** Canonical form of a user link (http(s), mailto or "#el=<id>"), or null when unsafe. */
export const normalizeLink = (input: string): string | null => {
  const v = input.trim();
  if (!v) return null;
  if (v.startsWith("#el=")) return v.length > 4 ? v : null;
  let candidate = v;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) candidate = `https://${v}`;
  try {
    const url = new URL(candidate);
    if (!SAFE_SCHEMES.includes(url.protocol)) return null;
    if (url.protocol !== "mailto:" && !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
};
