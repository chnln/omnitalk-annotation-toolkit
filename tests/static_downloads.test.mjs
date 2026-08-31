import test from "node:test";
import assert from "node:assert/strict";
import { initDownloads } from "../src/annotation_toolkit/static/downloads.js";

/** Only the DOM operations used by the browser-edition download dialog. */
class Element {
  constructor(tag) {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, listeners: {}, className: "", textContent: "", disabled: false, open: false, modalCount: 0 });
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  click() { if (!this.disabled) for (const handler of this.listeners.click || []) handler(); }
  showModal() { this.open = true; this.modalCount += 1; }
  close() { this.open = false; }
  querySelector(selector) {
    const matches = (node) => selector.startsWith("#") ? node.id === selector.slice(1)
      : selector.startsWith(".") ? node.className.split(" ").includes(selector.slice(1))
      : node.tagName.toLowerCase() === selector;
    for (const child of this.children) {
      if (matches(child)) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }
  set innerHTML(markup) {
    // A flat descendant list is sufficient here; no layout or HTML serialization is tested.
    this.children = [];
    for (const [, tag, attributes, text] of markup.matchAll(/<([a-z][\w-]*)([^>]*)>([^<]*)/g)) {
      const node = new Element(tag);
      node.textContent = text;
      for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
        node.setAttribute(name, value);
        if (name === "class") node.className = value;
        else if (["id", "href", "target", "rel"].includes(name)) node[name] = value;
      }
      this.append(node);
    }
  }
}

test("browser-edition download controls follow videos and clips and only offer local setup", (t) => {
  const originalDocument = globalThis.document;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const body = new Element("body");
  body.dataset.mode = "static";
  const heading = new Element("div");
  heading.className = "video-card-heading";
  const downloadAll = new Element("button");
  downloadAll.id = "download-all-clips";
  downloadAll.disabled = true;
  body.append(heading, downloadAll);
  globalThis.document = {
    body,
    createElement: (tag) => new Element(tag),
    querySelector: (selector) => body.querySelector(selector),
    getElementById: (id) => body.querySelector(`#${id}`),
  };
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Browser edition must not call the local API"); });
  let video = null;
  let clips = [];
  const ui = initDownloads({ getVideo: () => video, getClips: () => clips, getRange: () => null });
  const trigger = document.getElementById("download-video-button");
  const dialog = document.getElementById("download-dialog");
  assert.equal(trigger.disabled, true);
  assert.equal(downloadAll.disabled, true);
  trigger.click();
  assert.equal(dialog.open, false);
  assert.equal(network.mock.callCount(), 0);

  video = { video_id: "M7lc1UVf-VE", title: "Example video" };
  ui.refresh();
  assert.equal(trigger.disabled, false);
  assert.equal(downloadAll.disabled, true);
  clips = [{ id: "clip-1", start_seconds: 1.25, end_seconds: 4.5, note: "Keep this clip" }];
  ui.refresh();
  assert.equal(trigger.disabled, false);
  assert.equal(downloadAll.disabled, false, "Saved clips must enable Download all in the browser edition");

  for (const open of [() => trigger.click(), () => ui.open(), () => ui.openAll(), () => ui.open(clips[0])]) {
    const previousCount = dialog.modalCount;
    open();
    assert.equal(dialog.open, true);
    assert.equal(dialog.modalCount, previousCount + 1);
    assert.equal(dialog.querySelector("#download-heading").textContent, "Download videos locally");
    const setup = dialog.querySelector("a");
    assert.match(setup.href, /^https:\/\/github\.com\/[^/]+\/[^/]+#run-locally$/);
    assert.equal(setup.textContent.trim(), "Local setup ↗");
    assert.equal(dialog.querySelector("form"), null, "No download job may be submitted from the static dialog");
    dialog.querySelector("#download-cancel").click();
    assert.equal(dialog.open, false);
  }
  clips = [];
  ui.refresh();
  assert.equal(trigger.disabled, false);
  assert.equal(downloadAll.disabled, true);
  video = null;
  clips = [{ start_seconds: 0, end_seconds: 1 }];
  ui.refresh();
  assert.equal(trigger.disabled, true);
  assert.equal(downloadAll.disabled, true, "Stale clips without a selected video cannot enable Download all");
  assert.equal(network.mock.callCount(), 0);
});
