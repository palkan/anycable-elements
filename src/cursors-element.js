import { LitElement, css, html } from "lit";
import { createCable } from "@anycable/web";
import { debounce } from "@github/mini-throttle";
import { nanoid } from "nanoid";
import { apcach, maxChroma, apcachToCss } from "apcach";

function getRandomColor() {
  let hue = Math.random() * 360;
  let apcachColor = apcach(63, maxChroma(0.2), hue);
  let color = apcachToCss(apcachColor, "oklch");
  return color;
}

function indexedSelector(node) {
  let i = 1;
  let hasSiblingsOfType = false;
  let tagName = node.localName;

  while (node.previousSibling) {
    node = node.previousSibling;
    if (
      node.nodeType === 1 &&
      tagName.toLowerCase() == node.tagName.toLowerCase()
    ) {
      hasSiblingsOfType = true;
      i++;
    }
  }

  if (!hasSiblingsOfType) return tagName;

  return `${tagName}:nth-of-type(${i})`;
}

const pathSelector = (path) => {
  let context = path.shift();

  let el = context;
  if (el.__path_selector) return el.__path_selector;

  let pathSelector;

  while (context) {
    if (context.localName) {
      let indexSelector = indexedSelector(context);
      let delimiter = pathSelector ? " > " + pathSelector : "";

      if (context.shadowRoot && context.shadowRoot != context.getRootNode()) {
        delimiter = "::shadow " + pathSelector;
      }

      pathSelector = indexSelector + delimiter;
    }

    context = path.shift();
  }

  el.__path_selector = pathSelector;
  return pathSelector;
};

const pathLocator = (path) => {
  const parts = path.split("::shadow ");

  let root = document;
  let el;

  while (parts.length) {
    let part = parts.shift();
    el = root.querySelector(part);

    if (!el) break;

    root = el.shadowRoot;
  }

  return el;
};

class Cursor {
  constructor(id, el) {
    this.id = id;
    this.el = el;
  }

  keepalive(location) {
    const { path, x, y } = location;

    const el = pathLocator(path);

    if (!el) return;

    const rect = el.getBoundingClientRect();

    // console.log(path, el, rect, x, y);

    const newX = document.documentElement.scrollLeft + rect.left + x;
    const newY = document.documentElement.scrollTop + rect.top + y;

    this.el.style.transform = `translate(${newX}px, ${newY}px)`;
    this.deadline = Date.now();
  }

  get expired() {
    return Date.now() - this.deadline > 2000;
  }

  die() {
    this.el.remove();
  }
}

export class AnyCableCursorsElement extends LitElement {
  static get properties() {
    return {};
  }

  constructor() {
    super();
    this.userId = this.getAttribute("user-id") || nanoid();
    this.color = this.getAttribute("color") || getRandomColor();
    this.url = this.getAttribute("url");
    this.streamName = this.getAttribute("stream-name");
    this.signedStreamName = this.getAttribute("signed-stream-name");
    this.throttle = parseInt(this.getAttribute("throttle"));

    this.connected = false;
    this.cursors = {};
    this._handleMessage = this._handleMessage.bind(this);

    if (this.throttle) {
      this._handleMove = debounce(this._handleMove.bind(this), this.throttle);
    } else {
      this._handleMove = this._handleMove.bind(this);
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.cable = createCable(this.url);

    if (this.streamName) {
      this.channel = this.cable.streamFrom(this.streamName);
    } else if (this.signedStreamName) {
      this.channel = this.cable.streamFromSigned(this.signedStreamName);
    }

    this.channel.on("connect", () => {
      this.connected = true;
      this._start();
    });

    this.channel.on("disconnect", () => {
      this.connected = false;
      this._stop();
    });

    this.channel.on("message", this._handleMessage);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    if (this.cable) {
      this.cable.disconnect();
      this.cursors = {};
      this.connected = false;
    }
  }

  _start() {
    document.addEventListener("mousemove", this._handleMove, false);
  }

  _stop() {
    document.removeEventListener("mousemove", this._handleMove);
    this._cursor.die();
  }

  _createCursor(id, color) {
    const tpl = this.renderRoot.querySelector("template");
    const clone = tpl.content.cloneNode(true);
    const el = clone.children[0];

    el.id = `cursor-${id}`;
    el.style.color = color;

    this.renderRoot.appendChild(clone);

    const cursor = new Cursor(
      id,
      this.renderRoot.getElementById(`cursor-${id}`)
    );
    return cursor;
  }

  _handleMove(e) {
    const composedPath = e.composedPath();
    const rect = composedPath[0].getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const path = pathSelector(composedPath);

    // console.log(path, x, y);

    const location = { path, x, y };

    this.channel.whisper({
      event: "move",
      id: this.userId,
      color: this.color,
      location,
    });
  }

  _handleMessage(msg) {
    if (msg.event === "move") {
      const { id, color, location } = msg;

      if (!this.cursors[id]) {
        this.cursors[id] = this._createCursor(id, color);
      }

      this.cursors[id].keepalive(location);

      this._invalidateCursors();
    }

    // console.log(msg);
  }

  _invalidateCursors() {
    for (const id in this.cursors) {
      const cursor = this.cursors[id];
      if (cursor.expired) {
        cursor.die();
        delete this.cursors[id];
      }
    }

    if (!this._tid) {
      this._tid = setTimeout(() => {
        delete this._tid;
        this._invalidateCursors();
      }, 500);
    }
  }

  render() {
    return html`
      <template>
        <div class="cursor">
          <svg width="15" height="21" viewBox="0 0 15 21" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M0.487213 0.141484C0.789388 -0.0390029 1.1642 -0.0473412 1.4741 0.119529L14.4741 7.11953C14.798 7.29394 15 7.63212 15 8V16C15 16.3788 14.786 16.725 14.4472 16.8944L6.44721 20.8944C6.20425 21.0159 5.92233 21.0333 5.66627 20.9427C5.4102 20.852 5.20204 20.6611 5.08963 20.4138L0.0896335 9.4138C0.0305628 9.28385 0 9.14275 0 9V1C0 0.648027 0.185039 0.321971 0.487213 0.141484Z" fill="white"/>
            <path id="cursorBody" fill-rule="evenodd" clip-rule="evenodd" d="M1 9V2V1L14 8V9V16L6 20L1 9ZM13.037 8.48148L1.60185 2.32407L6 12L13.037 8.48148Z" fill="currentColor"/>
            <path fill-rule="evenodd" clip-rule="evenodd" d="M1 1L14 8V9V16L6 20V12L13.037 8.48148L1 2V1Z" fill="url(#paint0_linear_2849_1541)"/>
            <defs>
              <linearGradient id="paint0_linear_2849_1541" x1="1" y1="1" x2="10" y2="10" gradientUnits="userSpaceOnUse">
                <stop stop-color="white" stop-opacity="0"/>
                <stop offset="1" stop-color="white" stop-opacity="0.3"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
      </template>
    `;
  }

  static get styles() {
    return css`
      :host {
        height: 0;
        margin: 0;
        overflow: visible;
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 10000;
      }


      @media (prefers-color-scheme: light) {
      }
    `;
  }
}

window.customElements.define("anycable-cursors", AnyCableCursorsElement);
