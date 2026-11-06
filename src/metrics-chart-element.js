import { LitElement, css, html, svg, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { minireset } from "minireset.css/minireset.css.lit.js";

// Categorical series colors, in a fixed order (validated for color-vision
// deficiency on light surfaces). Override via --metrics-series-N.
const DEFAULT_COLORS = [
  "oklch(0.575 0.163 255.5)", // blue
  "oklch(0.671 0.175 40.6)", // orange
  "oklch(0.669 0.141 162.1)", // aqua
  "oklch(0.764 0.161 75.1)", // yellow
  "oklch(0.716 0.141 357.4)", // magenta
  "oklch(0.527 0.197 283.4)", // violet
];

const TIME_STEPS = [
  5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5,
  216e5,
];
const MIN_TICK_PX = 80;

const PADDING = {
  chart: { t: 6, r: 2, b: 20, l: 48 },
  number: { t: 2, r: 0, b: 2, l: 0 },
};

const LEGEND_HINT = "Click to show only this series. Ctrl/⌘-click to show or hide it.";

// Lucide icons: maximize-2, minimize-2
export const ICON_EXPAND = svg`<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" x2="14" y1="3" y2="10"></line><line x1="3" x2="10" y1="21" y2="14"></line>`;
export const ICON_COLLAPSE = svg`<polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" x2="21" y1="10" y2="3"></line><line x1="3" x2="10" y1="21" y2="14"></line>`;

const compactFormat = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"];

export const formatValue = (v, format) => {
  if (v == null || Number.isNaN(v)) return "–";

  if (format === "bytes") {
    let i = 0;
    while (Math.abs(v) >= 1000 && i < BYTE_UNITS.length - 1) {
      v /= 1000;
      i++;
    }
    const num = i ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v);
    return `${num} ${BYTE_UNITS[i]}`;
  }

  return compactFormat.format(v);
};

const minutesFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const secondsFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const niceStep = (range, count) => {
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
};

// Index of the row closest to ts (rows are sorted by ts)
const closestIndex = (rows, ts) => {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && ts - rows[lo - 1].ts < rows[lo].ts - ts) return lo - 1;
  return lo;
};

// Splits row indexes into continuous runs (no missing values, no time gaps)
const segments = (rows, values, gapMs) => {
  const result = [];
  let current = null;
  let prevTs;

  rows.forEach((row, i) => {
    if (values[i] == null) {
      current = null;
      return;
    }
    if (!current || row.ts - prevTs > gapMs) {
      current = [];
      result.push(current);
    }
    current.push(i);
    prevTs = row.ts;
  });

  return result;
};

/**
 * A single chart (a card) inside <anycable-metrics>.
 *
 * @attr heading - chart title
 * @attr type - line (default), area, bar, number
 * @attr metrics - comma-separated metric names
 * @attr labels - comma-separated series labels (default: metric names)
 * @attr mode - how to show counters: rate (per second, default), delta (per interval) or total
 * @attr format - number (default) or bytes
 * @attr stacked - stack area series (bars with many series are always stacked)
 * @attr expanded - the chart takes the full row
 */
export class AnyCableMetricsChartElement extends LitElement {
  static get properties() {
    return {
      heading: { type: String },
      type: { type: String, reflect: true },
      metrics: { type: String },
      labels: { type: String },
      mode: { type: String },
      format: { type: String },
      stacked: { type: Boolean },
      expanded: { type: Boolean, reflect: true },
      data: { attribute: false },
      hover: { attribute: false },
      _size: { state: true },
      _hidden: { state: true },
    };
  }

  constructor() {
    super();
    this.heading = "";
    this.type = "line";
    this.metrics = "";
    this.labels = "";
    this.mode = "rate";
    this.format = "number";
    this.stacked = false;
    this.expanded = false;
    this.data = null;
    this.hover = null;

    this._size = { width: 0, height: 0 };
    this._hidden = new Set();
    this._series = [];
    this._rows = [];
    this._levels = [];
    this._viewNow = Date.now();
    this._t0 = null;
    this._geom = null;
    this._ticksValidUntil = 0;
    this._uid = `m${Math.random().toString(36).slice(2, 8)}`;

    this._resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width !== this._size.width || height !== this._size.height) {
        this._size = { width, height };
      }
    });
  }

  connectedCallback() {
    super.connectedCallback();

    if (this._plotEl) this._resizeObserver.observe(this._plotEl);

    const container = this.closest("anycable-metrics");
    if (!container) return;

    customElements.whenDefined("anycable-metrics").then(() => {
      if (!this.isConnected || this.closest("anycable-metrics") !== container)
        return;
      this._container = container;
      container.register(this);
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver.disconnect();
    this._container?.unregister(this);
    this._container = null;
  }

  firstUpdated() {
    this._plotEl = this.renderRoot.querySelector(".plot");
    this._resizeObserver.observe(this._plotEl);
  }

  // Called by the container on every animation frame
  tick(now) {
    this._viewNow = now;
    this._applyScroll();
    if (this._geom && now > this._ticksValidUntil) this.requestUpdate();
  }

  willUpdate(changed) {
    if (changed.has("metrics")) this._hidden = new Set();

    if (
      changed.has("data") ||
      changed.has("metrics") ||
      changed.has("labels") ||
      changed.has("mode")
    ) {
      this._compute();
    }
  }

  updated() {
    this._scrollEl = this.renderRoot.querySelector(".scroll");
    this._tooltipEl = this.renderRoot.querySelector(".tooltip");
    this._applyScroll();
  }

  _compute() {
    const names = this.metrics
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (names.length > DEFAULT_COLORS.length) {
      console.warn(
        `[anycable-metrics-chart] too many metrics, showing the first ${DEFAULT_COLORS.length}`
      );
      names.length = DEFAULT_COLORS.length;
    }

    const labels = this.labels.split(",").map((s) => s.trim());
    const data = this.data;

    this._series = names.map((name, i) => ({
      name,
      label: labels[i] || name,
      kind: data && this._kindOf(name, data),
      desc: data?.meta.get(name)?.desc,
      color: `var(--metrics-series-${i + 1}, ${DEFAULT_COLORS[i]})`,
    }));

    if (!data) {
      this._rows = [];
      return;
    }

    const intervalSec = data.intervalMs / 1000;

    this._rows = data.points.map((point) => ({
      ts: point.ts,
      values: this._series.map((s) => {
        if (s.kind === "counter" && this.mode !== "total") {
          const v = point.deltas[s.name];
          if (v == null) return null;
          return this.mode === "delta" ? v : v / intervalSec;
        }
        return point.values[s.name] ?? null;
      }),
    }));

    if (this._t0 == null && this._rows.length) this._t0 = this._rows[0].ts;
  }

  // Kind comes from meta; fall back to the data shape (only counters have deltas)
  _kindOf(name, data) {
    const kind = data.meta.get(name)?.kind;
    if (kind) return kind;
    const point = data.points[data.points.length - 1];
    if (!point) return undefined;
    return name in point.deltas ? "counter" : "gauge";
  }

  get _isStacked() {
    return this.type === "bar" || (this.type === "area" && this.stacked);
  }

  _visible(si) {
    return !this._hidden.has(si);
  }

  _fmt(v, series) {
    const suffix =
      series.kind === "counter" && this.mode !== "delta" && this.mode !== "total"
        ? "/s"
        : "";
    return formatValue(v, this.format) + (v == null ? "" : suffix);
  }

  _geometry() {
    const { width, height } = this._size;
    const pad = this.type === "number" ? PADDING.number : PADDING.chart;
    const plotW = Math.max(0, width - pad.l - pad.r);
    const plotH = Math.max(0, height - pad.t - pad.b);
    const windowMs = this.data?.windowMs ?? 3_600_000;

    return {
      width,
      height,
      pad,
      plotW,
      plotH,
      windowMs,
      pxPerMs: plotW / windowMs,
    };
  }

  _yDomain() {
    const stacked = this._isStacked;
    let min = Infinity;
    let max = -Infinity;

    for (const row of this._rows) {
      if (stacked) {
        let sum = 0;
        row.values.forEach((v, si) => {
          if (this._visible(si)) sum += v ?? 0;
        });
        max = Math.max(max, sum);
        min = 0;
      } else {
        row.values.forEach((v, si) => {
          if (v == null || !this._visible(si)) return;
          if (v < min) min = v;
          if (v > max) max = v;
        });
      }
    }

    if (!Number.isFinite(max)) return { min: 0, max: 1, ticks: [] };

    // Sparkline: fit the data range to show the trend
    if (this.type === "number") {
      if (min === max) {
        min -= 1;
        max += 1;
      }
      const extra = (max - min) * 0.1;
      return { min: min - extra, max: max + extra, ticks: [] };
    }

    const step = niceStep(max || 1, 4);
    max = Math.ceil(max / step) * step || step;

    const ticks = [];
    for (let v = 0; v <= max + step / 2; v += step) ticks.push(v);

    return { min: 0, max, ticks };
  }

  _xTicks(g) {
    const step =
      TIME_STEPS.find((s) => s * g.pxPerMs >= MIN_TICK_PX) ??
      TIME_STEPS[TIME_STEPS.length - 1];
    const now = this._viewNow;
    const from = Math.floor((now - g.windowMs) / step) * step - step;
    const to = now + 2 * step;

    this._ticksValidUntil = now + step;

    const ticks = [];
    for (let t = from; t <= to; t += step) ticks.push(t);

    const fmt = step < 60_000 ? secondsFormat : minutesFormat;
    return ticks.map((t) => ({ t, label: fmt.format(t) }));
  }

  // Computes stacked (or flat) [lo, hi] levels for each visible series
  _computeLevels() {
    const stacked = this._isStacked;
    const base = new Array(this._rows.length).fill(0);

    this._levels = this._series.map((_, si) => {
      const lo = [];
      const hi = [];
      const visible = this._visible(si);
      this._rows.forEach((row, ri) => {
        const v = row.values[si];
        if (v == null || !visible) {
          lo.push(null);
          hi.push(null);
          return;
        }
        const b = stacked ? base[ri] : 0;
        lo.push(b);
        hi.push(b + v);
        if (stacked) base[ri] += v;
      });
      return { lo, hi };
    });
  }

  _marks(g, x, y) {
    const rows = this._rows;
    const gapMs = this.data.intervalMs * 2.5;
    const single = this._series.length === 1;

    return this._series.map((s, si) => {
      if (!this._visible(si)) return nothing;

      const { lo, hi } = this._levels[si];

      if (this.type === "bar") {
        const step = this.data.intervalMs * g.pxPerMs;
        const w = Math.max(1, step > 4 ? step - 2 : step);
        let d = "";
        rows.forEach((row, i) => {
          if (hi[i] == null || hi[i] === lo[i]) return;
          const x1 = x(row.ts) - w;
          d += `M${x1.toFixed(1)},${y(hi[i]).toFixed(1)}h${w.toFixed(1)}V${y(lo[i]).toFixed(1)}H${x1.toFixed(1)}Z`;
        });
        return svg`<path class="bar" style="fill:${s.color}" d=${d}></path>`;
      }

      const segs = segments(rows, hi, gapMs);
      const pt = (i, levels) =>
        `${x(rows[i].ts).toFixed(1)},${y(levels[i]).toFixed(1)}`;

      const line = segs
        .map(
          (seg) =>
            seg.map((i, k) => `${k ? "L" : "M"}${pt(i, hi)}`).join("") +
            (seg.length === 1 ? "h0" : "")
        )
        .join("");

      const withFill =
        this.type === "area" || (this.type === "number" && single);

      const fill = withFill
        ? segs
            .filter((seg) => seg.length > 1)
            .map((seg) => {
              const top = seg.map((i, k) => `${k ? "L" : "M"}${pt(i, hi)}`);
              const bottom = seg
                .slice()
                .reverse()
                .map((i) => `L${pt(i, lo)}`);
              return top.join("") + bottom.join("") + "Z";
            })
            .join("")
        : "";

      const fillOpacity = this._isStacked ? 0.3 : 0.12;

      return svg`
        ${fill ? svg`<path class="fill" style="fill:${s.color};fill-opacity:${fillOpacity}" d=${fill}></path>` : nothing}
        <path class="line" style="stroke:${s.color}" d=${line}></path>
      `;
    });
  }

  _hoverIndex() {
    if (!this.hover || !this._rows.length || !this.data) return null;
    const idx = closestIndex(this._rows, this.hover.ts);
    if (Math.abs(this._rows[idx].ts - this.hover.ts) > this.data.intervalMs * 2)
      return null;
    return idx;
  }

  _translateX() {
    const g = this._geom;
    return g.pad.l + g.plotW - (this._viewNow - this._t0) * g.pxPerMs;
  }

  _applyScroll() {
    if (!this._geom || this._t0 == null) return;

    const tx = this._translateX();
    this._scrollEl?.setAttribute("transform", `translate(${tx.toFixed(2)},0)`);

    if (this._tooltipEl && this._hoverX != null) {
      const cx = tx + this._hoverX;
      const tw = this._tooltipEl.offsetWidth;
      const left = cx > this._geom.width / 2 ? cx - 12 - tw : cx + 12;
      this._tooltipEl.style.transform = `translate(${left.toFixed(1)}px, 0)`;
    }
  }

  _onPointerMove(e) {
    const g = this._geom;
    if (!g || !this._rows.length) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const ts = this._viewNow - (g.pad.l + g.plotW - px) / g.pxPerMs;
    const snapped = this._rows[closestIndex(this._rows, ts)].ts;

    if (this.hover?.own && this.hover.ts === snapped) return;

    if (this._container) this._container.setHover(snapped, this);
    else this.hover = { ts: snapped, own: true };
  }

  _onPointerLeave() {
    if (this._container) this._container.setHover(null, this);
    else this.hover = null;
  }

  // Grafana-like: click isolates the series (or shows all again),
  // Ctrl/⌘/Shift-click toggles one series
  _onLegendClick(e, si) {
    const n = this._series.length;
    let hidden;

    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      hidden = new Set(this._hidden);
      if (hidden.has(si)) hidden.delete(si);
      else hidden.add(si);
      // Never hide everything
      if (hidden.size === n) hidden = new Set();
    } else {
      const isolated = this._hidden.size === n - 1 && !this._hidden.has(si);
      hidden = new Set();
      if (!isolated) {
        for (let i = 0; i < n; i++) if (i !== si) hidden.add(i);
      }
    }

    this._hidden = hidden;
  }

  _onExpandClick() {
    if (this._container) this._container.toggleExpanded(this);
    else this.expanded = !this.expanded;
  }

  _renderHeader() {
    const desc = this._series.length === 1 ? this._series[0].desc : undefined;
    const label = this.expanded ? "Collapse chart" : "Expand chart";

    return html`<header>
      <h3 title=${ifDefined(desc)}>${this.heading}</h3>
      <button
        type="button"
        class="icon-button"
        aria-label=${label}
        title=${label}
        aria-pressed=${this.expanded ? "true" : "false"}
        @click=${this._onExpandClick}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          ${this.expanded ? ICON_COLLAPSE : ICON_EXPAND}
        </svg>
      </button>
    </header>`;
  }

  _renderLegend() {
    if (this._series.length < 2 || this.type === "number") return nothing;

    return html`<ul class="legend">
      ${this._series.map(
        (s, si) =>
          html`<li>
            <button
              type="button"
              aria-pressed=${this._visible(si) ? "true" : "false"}
              title=${s.desc ? `${s.desc}\n\n${LEGEND_HINT}` : LEGEND_HINT}
              @click=${(e) => this._onLegendClick(e, si)}
            >
              <i class="key" style="background:${s.color}"></i>${s.label}
            </button>
          </li>`
      )}
    </ul>`;
  }

  // Stat: the latest value(s), like a Grafana stat panel
  _renderNumber() {
    const row = this._rows[this._rows.length - 1];
    const many = this._series.length > 1;

    return html`<div class="values">
      ${this._series.map(
        (s, si) => html`<div class="value">
          <strong>${this._fmt(row?.values[si], s)}</strong>
          ${many
            ? html`<span title=${ifDefined(s.desc)}
                ><i class="key" style="background:${s.color}"></i>${s.label}</span
              >`
            : nothing}
        </div>`
      )}
    </div>`;
  }

  _renderTooltip(idx) {
    if (idx == null || !this.hover?.own || this.type === "number") {
      return nothing;
    }

    const row = this._rows[idx];

    return html`<div class="tooltip">
      <time>${secondsFormat.format(row.ts)}</time>
      ${this._series.map((s, si) =>
        this._visible(si)
          ? html`<div class="row">
              <i class="key" style="background:${s.color}"></i>
              <span>${s.label}</span>
              <strong>${this._fmt(row.values[si], s)}</strong>
            </div>`
          : nothing
      )}
    </div>`;
  }

  _renderSVG(g, hoverIdx) {
    const number = this.type === "number";
    const plotBottom = g.pad.t + g.plotH;
    const x = (ts) => (ts - this._t0) * g.pxPerMs;

    // Paths only change with data, size, or visibility; hover re-renders reuse them
    const cacheKey = [
      this.data.version,
      g.width,
      g.height,
      this.type,
      this.stacked,
      this.metrics,
      this.mode,
      this.format,
      [...this._hidden].join(","),
    ].join("|");

    if (this._cache?.key !== cacheKey) {
      const dom = this._yDomain();
      const y = (v) =>
        g.pad.t + g.plotH - ((v - dom.min) / (dom.max - dom.min)) * g.plotH;
      this._computeLevels();
      this._cache = { key: cacheKey, dom, y, marks: this._marks(g, x, y) };
    }

    const { dom, y, marks } = this._cache;
    const xTicks = number ? [] : this._xTicks(g);

    let crosshair = nothing;
    this._hoverX = null;
    if (hoverIdx != null) {
      const cx = x(this._rows[hoverIdx].ts);
      this._hoverX = cx;
      crosshair = svg`<g class="crosshair">
        <line x1=${cx} x2=${cx} y1=${g.pad.t} y2=${plotBottom}></line>
        ${this._series.map((s, si) => {
          const v = this._levels[si].hi[hoverIdx];
          return v == null
            ? nothing
            : svg`<circle cx=${cx} cy=${y(v)} r="4" style="fill:${s.color}"></circle>`;
        })}
      </g>`;
    }

    return html`<svg
      width=${g.width}
      height=${g.height}
      @pointermove=${this._onPointerMove}
      @pointerleave=${this._onPointerLeave}
    >
      <defs>
        <clipPath id="${this._uid}-plot">
          <rect x=${g.pad.l} y="0" width=${g.plotW} height=${g.height}></rect>
        </clipPath>
      </defs>
      ${dom.ticks.map(
        (v) => svg`
          <line class="grid" x1=${g.pad.l} x2=${g.pad.l + g.plotW} y1=${y(v)} y2=${y(v)}></line>
          <text class="y-label" x=${g.pad.l - 8} y=${y(v)} dy="0.32em">${formatValue(v, this.format)}</text>
        `
      )}
      <g clip-path="url(#${this._uid}-plot)">
        <g class="scroll">
          ${xTicks.map(
            ({ t, label }) => svg`
              <line class="grid" x1=${x(t)} x2=${x(t)} y1=${g.pad.t} y2=${plotBottom}></line>
              <text class="x-label" x=${x(t)} y=${g.height - 4}>${label}</text>
            `
          )}
          ${marks} ${crosshair}
        </g>
      </g>
    </svg>`;
  }

  render() {
    const g = this._geometry();
    const hasData = this._rows.length > 0;
    const ready = g.width > 0 && g.plotW > 0 && hasData;
    const hoverIdx = this._hoverIndex();

    this._geom = ready ? g : null;

    return html`
      ${this._renderHeader()}
      ${this.type === "number" ? this._renderNumber() : nothing}
      <div class="plot">
        ${ready
          ? this._renderSVG(g, hoverIdx)
          : html`<div class="empty">${hasData ? "" : "Waiting for data…"}</div>`}
        ${ready ? this._renderTooltip(hoverIdx) : nothing}
      </div>
      ${this._renderLegend()}
    `;
  }

  static get styles() {
    return [
      minireset,
      css`
        /* Poetry UI tokens (inherited from the host page); fallbacks: AnyCable+ light theme */
        :host {
          --_card: var(--card, oklch(1 0 0));
          --_fg: var(--card-foreground, var(--foreground, oklch(0.145 0 0)));
          --_muted: var(--muted, oklch(0.97 0 0));
          --_muted-fg: var(--muted-foreground, oklch(0.509 0.024 285.5));
          --_border: var(--border, oklch(0.922 0 0));
          --_ring: var(--ring, oklch(0.694 0.196 23.8));
          --_popover: var(--popover, oklch(1 0 0));
          --_popover-fg: var(--popover-foreground, oklch(0.145 0 0));
          --_radius: var(--radius, 0.5rem);

          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          min-width: 0;
          height: var(--metrics-chart-height, 280px);
          padding: 1rem;
          border-radius: calc(var(--_radius) + 4px);
          background-color: var(--_card);
          color: var(--_fg);
          box-shadow:
            0 0 0 1px color-mix(in oklab, var(--_fg) 10%, transparent),
            0 1px 2px 0 oklch(0 0 0 / 0.05);
          font-family: var(
            --metrics-font-family,
            var(--font-sans, "Stem Text", ui-sans-serif, system-ui, sans-serif)
          );
          font-size: 0.875rem;
          line-height: 1.5;
        }

        :host([type="number"]) {
          height: var(--metrics-chart-height, 168px);
        }

        :host([expanded]) {
          grid-column: 1 / -1;
          height: var(--metrics-chart-expanded-height, 440px);
        }

        header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          min-height: 1.5rem;
        }

        h3 {
          overflow: hidden;
          font-size: 0.875rem;
          font-weight: 500;
          line-height: 1.5;
          white-space: nowrap;
          text-overflow: ellipsis;
        }

        button {
          appearance: none;
          border: 1px solid transparent;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
        }

        button:focus-visible {
          outline: none;
          border-color: var(--_ring);
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--_ring) 50%, transparent);
        }

        /* Poetry ghost icon button, size icon-xs */
        .icon-button {
          display: inline-grid;
          flex: none;
          place-items: center;
          width: 1.5rem;
          height: 1.5rem;
          border-radius: min(calc(var(--_radius) - 2px), 8px);
          color: var(--_muted-fg);
          transition:
            color 0.15s,
            background-color 0.15s;
        }

        .icon-button:hover {
          background-color: var(--_muted);
          color: var(--_fg);
        }

        .icon-button svg {
          width: 0.875rem;
          height: 0.875rem;
        }

        .legend {
          display: flex;
          flex-wrap: wrap;
          gap: 0.125rem 0.25rem;
          margin: 0 -0.375rem -0.25rem;
          list-style: none;
        }

        .legend button {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.125rem 0.375rem;
          border-radius: calc(var(--_radius) - 2px);
          color: var(--_muted-fg);
          font-size: 0.75rem;
          transition:
            color 0.15s,
            background-color 0.15s,
            opacity 0.15s;
        }

        .legend button:hover {
          background-color: var(--_muted);
          color: var(--_fg);
        }

        .legend button[aria-pressed="false"] {
          opacity: 0.45;
        }

        .key {
          display: inline-block;
          flex: none;
          width: 0.75rem;
          height: 2px;
          border-radius: 1px;
        }

        .values {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 0.25rem 1.5rem;
        }

        .value {
          display: inline-flex;
          align-items: baseline;
          gap: 0.5rem;
        }

        .value strong {
          font-size: 1.875rem;
          font-weight: 600;
          line-height: 1.1;
          letter-spacing: -0.01em;
          font-variant-numeric: tabular-nums;
        }

        .value span {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          color: var(--_muted-fg);
          font-size: 0.75rem;
        }

        .plot {
          position: relative;
          flex: 1;
          min-height: 0;
        }

        svg {
          display: block;
          overflow: hidden;
        }

        .grid {
          stroke: var(--_border);
          stroke-width: 1;
          shape-rendering: crispEdges;
        }

        text {
          fill: var(--_muted-fg);
          font-family: inherit;
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }

        .y-label {
          text-anchor: end;
        }

        .x-label {
          text-anchor: middle;
        }

        .line {
          fill: none;
          stroke-width: 1.5;
          stroke-linejoin: round;
          stroke-linecap: round;
        }

        .fill,
        .bar {
          stroke: none;
        }

        .crosshair line {
          stroke: var(--_muted-fg);
          stroke-opacity: 0.6;
          stroke-width: 1;
        }

        .crosshair circle {
          stroke: var(--_card);
          stroke-width: 2;
        }

        /* Poetry popover */
        .tooltip {
          position: absolute;
          top: 0;
          left: 0;
          z-index: 1;
          display: grid;
          gap: 0.25rem;
          min-width: 9rem;
          padding: 0.5rem 0.75rem;
          border-radius: calc(var(--_radius) - 2px);
          background-color: var(--_popover);
          color: var(--_popover-fg);
          box-shadow:
            0 0 0 1px color-mix(in oklab, var(--_fg) 10%, transparent),
            0 4px 6px -1px oklch(0 0 0 / 0.1),
            0 2px 4px -2px oklch(0 0 0 / 0.1);
          font-size: 0.75rem;
          white-space: nowrap;
          pointer-events: none;
        }

        .tooltip time {
          color: var(--_muted-fg);
          font-variant-numeric: tabular-nums;
        }

        .tooltip .row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .tooltip span {
          color: var(--_muted-fg);
        }

        .tooltip strong {
          margin-left: auto;
          padding-left: 1rem;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
        }

        .empty {
          height: 100%;
          display: grid;
          place-items: center;
          color: var(--_muted-fg);
          font-size: 0.75rem;
        }
      `,
    ];
  }
}

window.customElements.define(
  "anycable-metrics-chart",
  AnyCableMetricsChartElement
);
