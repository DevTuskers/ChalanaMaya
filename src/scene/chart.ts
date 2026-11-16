/**
 * Spreadsheet charts (FILE-09): reads pasted spreadsheet rows and turns them into
 * ordinary editable board items (boxes, paths and words) grouped together.
 */
import { DEFAULT_STYLE } from "./constants";
import { createLinear, createShape, createText, newId } from "./elements";
import { layoutText } from "./text";
import type { ItemStyle, Point, SceneElement } from "./types";

export type ChartKind = "bar" | "line" | "radar";

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartData {
  labels: string[];
  series: ChartSeries[];
  /** Header text of the label column, if the data had a header row. */
  title: string | null;
}

export type ChartParse = { ok: true; data: ChartData } | { ok: false; error: string };

const splitRows = (text: string): string[][] => {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const tabbed = lines.some((l) => l.includes("\t"));
  const sep = tabbed ? "\t" : lines.some((l) => l.includes(";")) ? ";" : ",";
  return lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, "$1")));
};

/** Parses "1,234.5", "12%", "$40" etc. Returns null for non-numbers. */
export const parseNumber = (cell: string): number | null => {
  const t = cell.replace(/[\s,$€£¥%]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** True when pasted text looks like rows copied from a spreadsheet. */
export const looksLikeSpreadsheet = (text: string): boolean => {
  const rows = splitRows(text);
  if (rows.length < 2) return false;
  const cols = rows[0].length;
  if (cols < 2 && !rows.every((r) => r.length === 1 && parseNumber(r[0]) !== null)) return false;
  if (!rows.every((r) => r.length === cols)) return false;
  // at least one column below the first row is numeric
  return rows.slice(1).some((r) => r.some((c) => parseNumber(c) !== null));
};

export const parseSpreadsheet = (text: string): ChartParse => {
  const rows = splitRows(text);
  if (!rows.length)
    return { ok: false, error: "There is no data. Copy some spreadsheet rows first." };
  const width = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => [...r, ...Array<string>(width - r.length).fill("")]);
  const numericRow = (r: string[]) => r.some((c) => parseNumber(c) !== null);
  // header: first row whose numeric-looking cells are absent
  const hasHeader = grid.length > 1 && !numericRow(grid[0]);
  const header = hasHeader ? grid[0] : null;
  const body = hasHeader ? grid.slice(1) : grid;
  if (!body.length)
    return { ok: false, error: "Only a header row was found. Add rows with numbers below it." };

  // the label column is the first column if it is not numeric
  const firstNumeric = body.every((r) => parseNumber(r[0]) !== null);
  const labelCol = width > 1 && !firstNumeric ? 0 : -1;
  const valueCols: number[] = [];
  for (let c = 0; c < width; c++) {
    if (c === labelCol) continue;
    if (
      body.every((r) => r[c] === "" || parseNumber(r[c]) !== null) &&
      body.some((r) => parseNumber(r[c]) !== null)
    )
      valueCols.push(c);
  }
  if (!valueCols.length)
    return {
      ok: false,
      error:
        "No column of numbers was found. Put labels in the first column and numbers beside them.",
    };
  if (valueCols.length > 6)
    return { ok: false, error: "Too many number columns. Use up to 6 columns of values." };
  if (body.length > 40)
    return { ok: false, error: "Too many rows. Use up to 40 rows for a chart." };
  const labels = body.map((r, i) => (labelCol >= 0 ? r[labelCol] || `Row ${i + 1}` : `${i + 1}`));
  const series = valueCols.map((c, i) => ({
    name: header?.[c] || (valueCols.length > 1 ? `Series ${i + 1}` : "Values"),
    values: body.map((r) => parseNumber(r[c]) ?? 0),
  }));
  return {
    ok: true,
    data: { labels, series, title: header && labelCol >= 0 ? header[labelCol] || null : null },
  };
};

export const SERIES_COLORS = ["#007f78", "#b65b24", "#2f6fb5", "#6b8e23", "#c0392b", "#8a5a9e"];

const CHART_H = 220;
const BAR_W = 34;
const GAP = 18;

/** Whether a radar chart makes sense for the data (needs 3+ spokes). */
export const chartKindProblem = (kind: ChartKind, data: ChartData): string | null => {
  if (kind === "radar" && data.labels.length < 3)
    return "A radar chart needs at least 3 rows. Pick bars or a line instead.";
  if (kind === "radar" && data.series.some((s) => s.values.some((v) => v < 0)))
    return "A radar chart can't show negative numbers. Pick bars or a line instead.";
  if (kind === "line" && data.labels.length < 2) return "A line chart needs at least 2 rows.";
  return null;
};

/** Builds the chart as editable board items with the top-left at `origin`. */
export const buildChart = (
  data: ChartData,
  kind: ChartKind,
  origin: Point,
  style: ItemStyle = DEFAULT_STYLE,
): SceneElement[] => {
  const group = newId();
  const ink = style.strokeColor;
  const out: SceneElement[] = [];
  const base: ItemStyle = { ...style, roughness: 1, strokeStyle: "solid", opacity: 100 };
  const text = (s: string, x: number, y: number, align: "left" | "center" | "right" = "center") => {
    const t = layoutText(
      createText(x, y, { ...base, fontSize: 16, textAlign: align, strokeColor: ink }, s),
    );
    const dx = align === "center" ? t.width / 2 : align === "right" ? t.width : 0;
    out.push({ ...t, x: x - dx, y });
  };
  const line = (pts: Point[], color: string, width = 2, closed = false, fill = "transparent") => {
    const minX = Math.min(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const el = createLinear(
      "line",
      minX,
      minY,
      {
        ...base,
        strokeColor: color,
        strokeWidth: width,
        backgroundColor: fill,
        fillStyle: "solid",
      },
      pts.map((p) => ({ x: p.x - minX, y: p.y - minY })),
    );
    out.push({
      ...el,
      closed,
      width: Math.max(...pts.map((p) => p.x)) - minX,
      height: Math.max(...pts.map((p) => p.y)) - minY,
      opacity: closed ? 70 : 100,
    });
  };
  const all = data.series.flatMap((s) => s.values);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const { x: ox, y: oy } = origin;

  if (kind === "radar") {
    const r = CHART_H / 2;
    const cx = ox + r + 40;
    const cy = oy + r + 30;
    const n = data.labels.length;
    const at = (i: number, f: number) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      return { x: cx + Math.cos(a) * r * f, y: cy + Math.sin(a) * r * f };
    };
    line(Array.from({ length: n }, (_, i) => at(i, 1)).concat([at(0, 1)]), ink, 1);
    for (let i = 0; i < n; i++) {
      line([{ x: cx, y: cy }, at(i, 1)], ink, 1);
      const p = at(i, 1.18);
      text(data.labels[i], p.x, p.y - 10);
    }
    data.series.forEach((s, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length];
      const pts = s.values.map((v, i) => at(i, max ? v / max : 0));
      line([...pts, pts[0]], color, 2, true, color);
    });
  } else {
    const groups = data.labels.length;
    const step = kind === "bar" ? BAR_W * data.series.length + GAP : 60;
    const plotW = Math.max(step * groups, 160);
    const zeroY = oy + 30 + (max / span) * CHART_H;
    const yOf = (v: number) => zeroY - (v / span) * CHART_H;
    // axes
    line(
      [
        { x: ox, y: oy + 30 },
        { x: ox, y: oy + 30 + CHART_H },
      ],
      ink,
      1,
    );
    line(
      [
        { x: ox, y: zeroY },
        { x: ox + plotW + GAP, y: zeroY },
      ],
      ink,
      1,
    );
    text(String(+max.toPrecision(4)), ox - 6, oy + 20, "right");
    if (min < 0) text(String(+min.toPrecision(4)), ox - 6, oy + 30 + CHART_H - 10, "right");
    data.labels.forEach((label, i) => {
      const cx = ox + GAP + i * step + (kind === "bar" ? (BAR_W * data.series.length) / 2 : 0);
      text(label, cx, oy + 40 + CHART_H);
    });
    data.series.forEach((s, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length];
      if (kind === "bar") {
        s.values.forEach((v, i) => {
          const x = ox + GAP + i * step + si * BAR_W;
          const top = Math.min(yOf(v), zeroY);
          const h = Math.max(1, Math.abs(yOf(v) - zeroY));
          out.push(
            createShape(
              "rectangle",
              x,
              top,
              {
                ...base,
                strokeColor: color,
                backgroundColor: color,
                fillStyle: "hachure",
                strokeWidth: 1,
                edges: "sharp",
              },
              BAR_W - 4,
              h,
            ),
          );
        });
      } else {
        line(
          s.values.map((v, i) => ({ x: ox + GAP + i * step, y: yOf(v) })),
          color,
          2,
        );
      }
    });
  }
  // legend / title row above the chart
  let lx = ox;
  if (data.title) {
    text(data.title, lx, oy - 8, "left");
    lx += (out[out.length - 1] as { width: number }).width + 24;
  }
  if (data.series.length > 1 || kind !== "bar") {
    data.series.forEach((s, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length];
      out.push(
        createShape(
          "rectangle",
          lx,
          oy - 4,
          {
            ...base,
            strokeColor: color,
            backgroundColor: color,
            fillStyle: "solid",
            strokeWidth: 1,
          },
          14,
          14,
        ),
      );
      text(s.name, lx + 20, oy - 8, "left");
      lx += 20 + (out[out.length - 1] as { width: number }).width + 20;
    });
  }
  return out.map((el) => ({ ...el, groupIds: [group] }));
};
