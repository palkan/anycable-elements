import { LitElement, css, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { minireset } from "minireset.css/minireset.css.lit.js";

const RESERVED_ATTRS = ["time", "level", "msg"];

const flatten = (data, acc = {}, prefix = "") => {
  if (typeof data !== "object") {
    if (prefix) return acc;
    // Original input is not an object
    return data;
  }

  const keyPrefix = prefix ? `${prefix}.` : "";

  for (let key in data) {
    const val = data[key];
    if (!val) continue;

    if (typeof val === "object") {
      flatten(val, acc, keyPrefix + key);
    } else {
      acc[keyPrefix + key] = val;
    }
  }

  return acc;
};

/**
 * An example element.
 *
 * @slot - This element has a slot
 * @csspart button - The button
 */
export class AnyCableLogsElement extends LitElement {
  static get properties() {
    return {
      connected: { type: Boolean },
      error: { type: Error },
      url: { type: String },
      filter: { type: String },
    };
  }

  constructor() {
    super();
    this.connected = false;
    this.reconnecting = false;
    this.filter = "";
    this.linesCount = 0;
    this.lines = [];

    this._handleMessage = this._handleMessage.bind(this);
    this._filterAlike = this._filterAlike.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    const source = (this.source = new EventSource(this.url));

    source.onopen = () => {
      this.connected = true;
      this.reconnecting = false;
      this.error = null;
      this.requestUpdate();
    };

    source.onerror = () => {
      if (this.connected) {
        this.reconnecting = true;
        this._append(
          JSON.stringify({
            level: "ERROR",
            msg: "connection lost",
          })
        );
      } else {
        this.error = new Error("failed to connect to event source");
      }
      this.requestUpdate();
    };

    source.addEventListener("welcome", this._handleMessage);
    source.addEventListener("disconnect", this._handleMessage);
    source.addEventListener("confirm_subscription", this._handleMessage);
    source.addEventListener("reject_subscription", this._handleMessage);
    source.addEventListener("ping", this._handleMessage);
    source.onmessage = this._handleMessage;

    this.renderRoot.addEventListener("click", this._filterAlike);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.renderRoot.removeEventListener("click", this._filterAlike);

    if (this.source) {
      this.source.close();
      this.lines.length = 0;
    }
  }

  _handleMessage(msg) {
    if (msg.type === "ping") {
      this._animateStatus();
      return;
    }

    if (msg.type === "welcome") {
      this._append(
        JSON.stringify({
          level: "DEBUG",
          msg: "connected",
        })
      );
      this.requestUpdate();
      return;
    }

    if (msg.type === "confirm_subscription") {
      this._append(
        JSON.stringify({
          level: "DEBUG",
          msg: "subscribed",
        })
      );
      this.requestUpdate();
      return;
    }

    if (msg.type === "disconnect") {
      let { reason } = JSON.parse(msg.data);
      this._append(
        JSON.stringify({
          level: "ERROR",
          msg: "connection closed by server",
          reason,
        })
      );
      this.requestUpdate();
      return;
    }

    const lines = JSON.parse(msg.data);

    for (let line of lines) this._append(JSON.stringify(line));

    const consoleEl = this.renderRoot.querySelector(".console");
    this.shouldScroll =
      consoleEl.scrollTop + consoleEl.offsetHeight + 10 >
      consoleEl.scrollHeight;

    this.requestUpdate();
  }

  get _filteredLines() {
    return this.lines.filter((item) => this._matchFilter(item));
  }

  _append(data) {
    if (!data) return;

    try {
      data = JSON.parse(data);
    } catch (e) {
      console.error(e);
      return;
    }

    data = flatten(data);

    this.linesCount++;
    this.lines.push({ data, raw: this._compileLog(data), id: this.linesCount });
  }

  _matchFilter(item) {
    if (this.filter) {
      return this.filterRx.test(item.raw);
    }

    return true;
  }

  _onFilterChange(e) {
    this._filter(e.target.value);
  }

  _filterAlike(e) {
    if (e.target.classList.contains("log-filter")) {
      e.preventDefault();

      const val = e.target.textContent;

      const filterEl = this.renderRoot.getElementById("filter");
      this._filter(val);
      filterEl.value = val;
    }
  }

  _resetFilter() {
    const filterEl = this.renderRoot.getElementById("filter");
    this._filter("");
    filterEl.value = "";
  }

  _filter(query) {
    this.filter = query;

    if (this.filter) {
      this.filterRx = new RegExp(`((?:^|>)[^<>]*?)(${this.filter})`, "gim");
    }

    // Always scroll after filtering
    this.shouldScroll = true;
  }

  // Generate a string representation of a log for filtering purposes
  _compileLog(data) {
    let ts = data["time"];
    let level = data["level"];
    let message = data["msg"];

    let buf = [];

    for (let attr in data) {
      if (RESERVED_ATTRS.includes(attr)) continue;

      let val = data[attr];

      if (!val) continue;

      if (typeof val === "object") {
        val = JSON.stringify(val);
      }

      buf.push(`${attr}=${val}`);
    }

    return `${ts} ${level} ${message} ${buf.join(" ")}`;
  }

  _formatLog(data) {
    let ts = html`<span class="log-ts">${this._highlight(data["time"])}</span>`;
    let level = html`[<span class="log-filter log-level-${data[
      "level"
    ].toLowerCase()}">${this._highlight(data["level"])}</span>]`;

    let message = html`<span class="log-message">${this._highlight(
      data["msg"]
    )}</span>`;

    let buf = [];

    for (let attr in data) {
      if (RESERVED_ATTRS.includes(attr)) continue;

      let val = data[attr];

      if (!val) continue;

      if (typeof val === "object") {
        val = JSON.stringify(val);
      }

      const attrval = `${attr}=${val}`;
      buf.push(`<span class="log-filter">${attrval}</span>`);
    }

    return html`<li>${ts} ${level} ${message} ${this._highlight(
      buf.join(" ")
    )}</li>`;
  }

  _highlight(str) {
    if (!this.filter) return unsafeHTML(str);

    return unsafeHTML(str.replace(this.filterRx, "$1<mark>$2</mark>"));
  }

  _animateStatus() {
    const el = this.renderRoot.querySelector(".status");

    if (!el) return;

    el.classList.add("status-animated");
  }

  _clearStatusAnimation() {
    const el = this.renderRoot.querySelector(".status");

    if (!el) return;

    el.classList.remove("status-animated");
  }

  updated() {
    super.updated();

    if (this.shouldScroll) {
      this.shouldScroll = false;

      const consoleEl = this.renderRoot.querySelector(".console");
      consoleEl.scrollTop = consoleEl.scrollHeight - consoleEl.offsetHeight;
    }
  }

  render() {
    if (this.error) {
      return html`<span class="status status-error"></span><div class="console"><div class="log-level-error">Error: ${this.error.message}</div></div>`;
    }

    if (!this.connected) {
      return html`<span class="status status-loading"></span><div class="console">Loading...</div>`;
    }

    return html`
      <span class="status ${
        this.reconnecting ? "status-loading" : ""
      }" @animationend=${this._clearStatusAnimation}></span>
      <nav>
        <i id="filter-icon">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z" />
          </svg>
        </i>
        <input type="text" id="filter" @input=${this._onFilterChange}/>
        <i id="reset-filter-icon" @click=${
          this._resetFilter
        } title="reset filter" style="${!this.filter && "display: none;"}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9.75 14.25 12m0 0 2.25 2.25M14.25 12l2.25-2.25M14.25 12 12 14.25m-2.58 4.92-6.374-6.375a1.125 1.125 0 0 1 0-1.59L9.42 4.83c.21-.211.497-.33.795-.33H19.5a2.25 2.25 0 0 1 2.25 2.25v10.5a2.25 2.25 0 0 1-2.25 2.25h-9.284c-.298 0-.585-.119-.795-.33Z" />
          </svg>
        </i>
      </nav>
      <ul class="console">
        ${repeat(
          this._filteredLines,
          (item) => item.id,
          (item) => this._formatLog(item.data)
        )}
      </ul>
    `;
  }

  static get styles() {
    return [
      minireset,
      css`
      :host {
        max-width: 1280px;
        height: 100%;
        margin: 0 auto;
        display: block;
        color: var(--console-color, rgb(134 239 172));
        background-color: var(--console-bg, rgb(27, 14, 65));
        border-radius: 8px;
        position: relative;
        font-family: var(--console-font-family, monospace);
      }

      .console {
        min-width: 100%;
        height: 100%;
        box-sizing: border-box;
        padding: 2rem;
        position: relative;
        list-style-type: none;
        word-wrap: break-word;
        overflow-y: scroll;
      }

      .console li {
        word-wrap: break-word;
      }

      .console li:hover {
        color: white;
      }

      .console li:not(:first-child) {
        margin-top: 0.5rem;
      }

      .log-level-info {
        color: cyan;
      }

      .log-level-error {
        color: red;
      }

      .log-level-warn {
        color: #FFBF00;
      }

      .log-filter {
        cursor: pointer;
      }

      .log-filter:hover {
        text-decoration: underline;
      }

      @keyframes status-blink {
        0% {opacity: 1;}
        50% {opacity: 0.5;}
        100% {opacity: 1;}
      }

      .status-animated {
        animation: status-blink 1s linear;
      }

      .status-loading {
        animation: status-blink 2s linear infinite;
        background-color: #FFBF00 !important;
      }

      .status-error {
        background-color: red !important;
      }

      .status {
        position: absolute;
        background-color: #4FFFB0;
        top: 10px;
        left: 10px;
        display: block;
        width: 10px;
        height: 10px;
        border-radius: 10px;
      }

      nav {
        min-width: 50%;
        position: absolute;
        top: 0.25rem;
        right: 2rem;
        z-index: 10;
        background-color: var(--console-bg, rgb(27, 14, 65));
        background-opacity: 0.75;
      }

      nav i {
        position: absolute;
        width: 1rem;
        height: 1rem;
        color: #fff;
      }

      #filter-icon {
        left: -1.25rem;
        top: 0.125rem;
      }

      #reset-filter-icon {
        right: -0.5rem;
        top: 0.125rem;
        cursor: pointer;
        transition: color 0.5s ease;
      }

      #reset-filter-icon:hover {
        color: var(--console-color, rgb(134 239 172));
      }

      nav input {
        margin-right: 0.75rem;
        width: 100%;
        appearance: none;
        outline: none;
        border-style: none;
        background-color: transparent;
        padding-top: 0.25rem;
        padding-bottom: 0.25rem;
        padding-right: 0.5rem;
        color: var(--controls-color, #fff);
        border-bottom: 1px solid var(--console-color, rgb(134 239 172));
        font-family: var(--console-font-family, monospace);
        font-size: 100%;
      }

      @media (prefers-color-scheme: light) {
      }
    `,
    ];
  }
}

window.customElements.define("anycable-logs", AnyCableLogsElement);
