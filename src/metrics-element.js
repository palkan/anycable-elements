import { LitElement, css, html, nothing } from "lit";
import { minireset } from "minireset.css/minireset.css.lit.js";
import { ICON_EXPAND, ICON_COLLAPSE } from "./metrics-chart-element.js";

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5000;

const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

// Parses "1h", "30m", "90s", "500ms"; a bare number means seconds
export const parseDuration = (str, fallback) => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(str || "");
  if (!match) return fallback;
  return parseFloat(match[1]) * DURATION_UNITS[match[2] || "s"];
};

// Server timestamps may come in seconds or milliseconds
const toMs = (ts) => (ts < 1e12 ? ts * 1000 : ts);

/**
 * A container for metrics charts.
 * Keeps a time-ordered buffer of metrics points and feeds it to the child
 * <anycable-metrics-chart> elements.
 *
 * Data is pushed via `ingest(message)`:
 *
 *   {type: "snapshot", interval: 5, meta: {<name>: {kind, desc}}, points: [{ts, values, deltas}]}
 *   {type: "point", point: {ts, values, deltas}}
 *
 * `values` holds current values (counter totals and gauges),
 * `deltas` holds per-interval counter changes.
 * A point can arrive both in a snapshot and as a broadcast; duplicates (by ts) are dropped.
 *
 * @attr window - the visible time window (e.g., "1h", "15m"); default: 1h
 * @attr hover - "shared" (default) syncs the hover across charts, "local" does not
 * @attr status - connection status: loading, connected, reconnecting, error
 */
export class AnyCableMetricsElement extends LitElement {
  static get properties() {
    return {
      timeWindow: { type: String, attribute: "window" },
      hover: { type: String },
      status: { type: String },
      error: { attribute: false },
    };
  }

  constructor() {
    super();
    this.timeWindow = "1h";
    this.hover = "shared";
    this.status = "loading";
    this.error = null;

    this.intervalMs = DEFAULT_INTERVAL_MS;
    this.points = [];
    this.meta = new Map();
    this.charts = new Set();

    this._lag = null;
    this._version = 0;
    this._hoverTs = null;

    this._frame = this._frame.bind(this);
  }

  get windowMs() {
    return parseDuration(this.timeWindow, DEFAULT_WINDOW_MS);
  }

  // The time at the right edge of the charts.
  // We stay one interval behind the clock, so new points slide in from the right
  get viewNow() {
    return Date.now() - (this._lag ?? 0) - this.intervalMs;
  }

  connectedCallback() {
    super.connectedCallback();
    this._raf = requestAnimationFrame(this._frame);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this._raf);
  }

  register(chart) {
    this.charts.add(chart);
    chart.data = this._snapshot();
    this.requestUpdate();
  }

  unregister(chart) {
    this.charts.delete(chart);
    this.requestUpdate();
  }

  ingest(msg) {
    if (!msg || typeof msg !== "object") return;

    let added = false;

    if (msg.type === "snapshot") {
      if (msg.interval) this.intervalMs = msg.interval * 1000;
      for (const name in msg.meta || {}) {
        this.meta.set(name, msg.meta[name]);
      }
      for (const point of msg.points || []) {
        if (this._addPoint(point)) added = true;
      }
      // Republish even if all points are duplicates: meta may have changed
      added = true;
    } else if (msg.type === "point") {
      added = this._addPoint(msg.point);
      if (added) this._trackLag(toMs(msg.point.ts));
      this._animateStatus();
    }

    if (!added) return;

    this._trim();
    this._publish();
  }

  setHover(ts, source) {
    if (this.hover === "local") {
      source.hover = ts == null ? null : { ts, own: true };
      return;
    }

    if (ts === this._hoverTs && source === this._hoverSource) return;

    this._hoverTs = ts;
    this._hoverSource = source;

    for (const chart of this.charts) {
      chart.hover = ts == null ? null : { ts, own: chart === source };
    }
  }

  _addPoint(raw) {
    if (!raw || raw.ts == null) return false;

    const point = {
      ts: toMs(raw.ts),
      values: raw.values || {},
      deltas: raw.deltas || {},
    };

    const points = this.points;
    const last = points[points.length - 1];

    if (!last || last.ts < point.ts) {
      points.push(point);
      return true;
    }

    // Out-of-order point (e.g., snapshot after reconnect): insert or skip duplicate
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].ts < point.ts) lo = mid + 1;
      else hi = mid;
    }

    if (points[lo] && points[lo].ts === point.ts) return false;

    points.splice(lo, 0, point);
    return true;
  }

  // Smooth the difference between the client clock and the server timestamps
  _trackLag(ts) {
    const lag = Date.now() - ts;
    this._lag = this._lag == null ? lag : this._lag * 0.8 + lag * 0.2;
  }

  _trim() {
    const cutoff = this.viewNow - this.windowMs - 2 * this.intervalMs;
    let i = 0;
    while (i < this.points.length && this.points[i].ts < cutoff) i++;
    if (i > 0) this.points.splice(0, i);
  }

  _snapshot() {
    return {
      points: this.points,
      meta: this.meta,
      intervalMs: this.intervalMs,
      windowMs: this.windowMs,
      version: this._version,
    };
  }

  _publish() {
    this._version++;
    const data = this._snapshot();
    for (const chart of this.charts) chart.data = data;
  }

  _frame() {
    const now = this.viewNow;
    for (const chart of this.charts) chart.tick(now);
    this._raf = requestAnimationFrame(this._frame);
  }

  // Expands/collapses one chart to the full row
  toggleExpanded(chart) {
    this._animateLayout(() => chart.toggleAttribute("expanded"), chart);
    if (chart.hasAttribute("expanded")) {
      chart.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // Expands all charts, or collapses all if every chart is already expanded
  toggleAllExpanded() {
    const expand = !this._allExpanded;
    this._animateLayout(() => {
      for (const chart of this.charts) chart.toggleAttribute("expanded", expand);
    });
  }

  get _allExpanded() {
    if (!this.charts.size) return false;
    for (const chart of this.charts) if (!chart.expanded) return false;
    return true;
  }

  // Changes the layout and animates charts to their new places
  // (FLIP: measure, change, then animate the transform back).
  // The change must apply synchronously (toggle attributes, not Lit properties)
  _animateLayout(change, focused) {
    const charts = [...this.charts];
    const first = new Map(charts.map((c) => [c, c.getBoundingClientRect()]));

    change();
    this.requestUpdate();

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    for (const c of charts) {
      const from = first.get(c);
      const to = c.getBoundingClientRect();
      if (!to.width || !to.height) continue;

      const dx = from.left - to.left;
      const dy = from.top - to.top;
      const sx = from.width / to.width;
      const sy = from.height / to.height;

      if (
        Math.abs(dx) < 1 &&
        Math.abs(dy) < 1 &&
        Math.abs(sx - 1) < 0.01 &&
        Math.abs(sy - 1) < 0.01
      )
        continue;

      const animation = c.animate(
        [
          {
            transformOrigin: "top left",
            transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
          },
          { transformOrigin: "top left", transform: "none" },
        ],
        { duration: 300, easing: "cubic-bezier(0.2, 0, 0, 1)" }
      );

      // Keep the resized chart above the others while it moves
      if (c === focused) {
        c.style.zIndex = "1";
        const reset = () => (c.style.zIndex = "");
        animation.finished.then(reset, reset);
      }
    }
  }

  _animateStatus() {
    this.renderRoot.querySelector(".dot")?.classList.add("dot-animated");
  }

  _clearStatusAnimation() {
    this.renderRoot.querySelector(".dot")?.classList.remove("dot-animated");
  }

  updated(changed) {
    if (changed.has("timeWindow") && changed.get("timeWindow") !== undefined) {
      this._trim();
      this._publish();
    }
  }

  render() {
    const label =
      {
        loading: "Connecting",
        connected: "Live",
        reconnecting: "Reconnecting",
        error: "Error",
      }[this.status] || this.status;
    const title = this.error ? `${label}: ${this.error.message}` : label;

    const expanded = this._allExpanded;
    const toggleLabel = expanded ? "Collapse all charts" : "Expand all charts";

    return html`
      <div class="toolbar">
        <button
          type="button"
          class="icon-button"
          aria-label=${toggleLabel}
          title=${toggleLabel}
          aria-pressed=${expanded ? "true" : "false"}
          @click=${this.toggleAllExpanded}
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
            ${expanded ? ICON_COLLAPSE : ICON_EXPAND}
          </svg>
        </button>
        <span class="status status-${this.status}" title=${title}>
          <i class="dot" @animationend=${this._clearStatusAnimation}></i>
          <span class="sr-only" role="status">${title}</span>
        </span>
      </div>
      <div class="charts"><slot></slot></div>
    `;
  }

  static get styles() {
    return [
      minireset,
      css`
        /* Poetry UI tokens (inherited from the host page); fallbacks: AnyCable+ light theme */
        :host {
          --_fg: var(--foreground, oklch(0.145 0 0));
          --_muted-fg: var(--muted-foreground, oklch(0.509 0.024 285.5));
          --_muted: var(--muted, oklch(0.97 0 0));
          --_ring: var(--ring, oklch(0.694 0.196 23.8));
          --_radius: var(--radius, 0.5rem);
          --_success: var(--success, oklch(0.726 0.155 164));
          --_warning: var(--warning, oklch(0.77 0.165 70.7));
          --_destructive: var(--destructive, oklch(0.577 0.245 27.325));

          display: block;
          color: var(--_fg);
          font-family: var(
            --metrics-font-family,
            var(--font-sans, "Stem Text", ui-sans-serif, system-ui, sans-serif)
          );
          font-size: 0.875rem;
          line-height: 1.5;
        }

        .toolbar {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }

        /* Poetry ghost icon button, size icon-xs */
        .icon-button {
          appearance: none;
          display: inline-grid;
          place-items: center;
          width: 1.5rem;
          height: 1.5rem;
          border: 1px solid transparent;
          border-radius: min(calc(var(--_radius) - 2px), 8px);
          background: transparent;
          color: var(--_muted-fg);
          cursor: pointer;
          transition:
            color 0.15s,
            background-color 0.15s;
        }

        .icon-button:hover {
          background-color: var(--_muted);
          color: var(--_fg);
        }

        .icon-button:focus-visible {
          outline: none;
          border-color: var(--_ring);
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--_ring) 50%, transparent);
        }

        .icon-button svg {
          width: 0.875rem;
          height: 0.875rem;
        }

        .status {
          display: inline-grid;
          place-items: center;
          width: 1.5rem;
          height: 1.5rem;
        }

        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          overflow: hidden;
          clip-path: inset(50%);
          white-space: nowrap;
        }

        .dot {
          width: 0.5rem;
          height: 0.5rem;
          border-radius: 50%;
          background-color: var(--_success);
        }

        .status-loading .dot,
        .status-reconnecting .dot {
          background-color: var(--_warning);
          animation: blink 2s linear infinite;
        }

        .status-error .dot {
          background-color: var(--_destructive);
        }

        .dot-animated {
          animation: blink 1s linear;
        }

        @keyframes blink {
          0% {opacity: 1;}
          50% {opacity: 0.4;}
          100% {opacity: 1;}
        }

        .charts {
          display: grid;
          grid-template-columns: repeat(
            auto-fill,
            minmax(min(100%, var(--metrics-chart-min-width, 340px)), 1fr)
          );
          gap: 1rem;
        }

        /* Anything other than a chart (e.g., a section heading) takes a full row */
        ::slotted(:not(anycable-metrics-chart)) {
          grid-column: 1 / -1;
        }

        ::slotted(:is(h1, h2, h3, h4)) {
          margin: 0.75rem 0 -0.25rem;
          font-size: 1rem;
          font-weight: 600;
          line-height: 1.5;
        }
      `,
    ];
  }
}

window.customElements.define("anycable-metrics", AnyCableMetricsElement);
