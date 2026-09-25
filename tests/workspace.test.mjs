import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as core from "../src/annotation_toolkit/static/core.js";

const appSource = readFileSync(new URL("../src/annotation_toolkit/static/app.js", import.meta.url), "utf8")
  .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "");
const html = readFileSync(new URL("../src/annotation_toolkit/static/index.html", import.meta.url), "utf8");
const sidebarStorageKey = "omnitalk.annotation.sidebar.collapsed.v1";

/** Small DOM doubles: exercise the production app, not copies of its handlers. */
class Node {
  constructor(tag, document) {
    Object.assign(this, { tagName: tag.toUpperCase(), document, children: [], attributes: {}, dataset: {}, listeners: {}, value: "", style: {}, hidden: false, disabled: false, className: "" });
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(" "), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const present = this.className.split(" ").includes(name);
        if (force ?? !present) this.classList.add(name); else this.classList.remove(name);
      },
    };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) {
    for (const node of nodes) { node.remove?.(); node.parent = this; this.children.push(node); }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
  }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  fire(name, extra = {}) {
    const event = { target: this, preventDefault() {}, ...extra };
    return Promise.all([...(this.listeners[name] || []), ...(typeof this[`on${name}`] === "function" ? [this[`on${name}`]] : [])].map((handler) => handler(event)));
  }
  focus() { this.document.activeElement = this; }
  click() {
    if (this.tagName === "A" && this.download) this.document.downloads.push({ url: this.href, filename: this.download });
    return this.fire("click");
  }
  scrollIntoView() { this.scrolledIntoView = true; }
  querySelectorAll(selector) {
    const attribute = /^\[data-([\w-]+)="([^"]+)"\]$/.exec(selector);
    const matches = (node) => selector.startsWith(".")
      ? node.className.split(" ").includes(selector.slice(1))
      : attribute && node.dataset[attribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] === attribute[2];
    return this.children.flatMap((node) => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { return node === this || this.children.some((child) => child.contains?.(node)); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire("close"); }
  get textContent() { return this._text ?? this.children.map((child) => child.textContent || "").join(""); }
  set textContent(text) { this._text = String(text); this.replaceChildren(); }
}

function workspace(savedStorage = [], { mode = "local", failSidebarStorage = false } = {}) {
  const document = {
    activeElement: null,
    downloads: [],
    createElement: (tag) => new Node(tag, document),
    createElementNS: (_, tag) => new Node(tag, document),
    createTextNode: (text) => { const node = new Node("text", document); node.textContent = text; return node; },
    addEventListener() {},
    querySelector: () => null,
  };
  document.head = document.createElement("head");
  document.body = document.createElement("body");
  document.body.dataset.mode = mode;
  for (const match of html.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = document.createElement(match[1]);
    node.id = match[2];
    for (const [, name, value] of match[0].matchAll(/([\w:-]+)="([^"]*)"/g)) node.setAttribute(name, value);
    document.body.append(node);
  }
  const find = (node, id) => node.id === id ? node : node.children.map((child) => find(child, id)).find(Boolean);
  document.getElementById = (id) => find(document.head, id) || find(document.body, id) || null;
  document.getElementById("youtube-mount").append(document.getElementById("youtube-player"));
  const storage = new Map(savedStorage);
  const timers = new Map();
  const instances = [];
  const refreshes = [];
  const downloadOpens = [];
  const exports = [];
  const blobs = new Map();
  let now = Date.now();
  let timerId = 0;
  const window = {
    listeners: {},
    addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); },
    fire(name, event) { for (const handler of this.listeners[name] || []) handler(event); },
  };
  class BrowserURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:workspace-test-${blobs.size}`;
      blobs.set(url, blob);
      return url;
    }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    ...core, document, window, URL: BrowserURL, URLSearchParams, Blob, console, AbortSignal,
    Date: class extends Date { static now() { return now; } },
    location: { origin: "http://127.0.0.1:8765" },
    localStorage: {
      getItem: (key) => { if (failSidebarStorage && key === sidebarStorageKey) throw new Error("Preference storage unavailable"); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (failSidebarStorage && key === sidebarStorageKey) throw new Error("Preference storage unavailable"); storage.set(key, value); },
    },
    setTimeout: (handler) => { timers.set(++timerId, handler); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    setInterval() {},
    fetch: async (url, options) => {
      assert.equal(url, "/api/exports");
      exports.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ path: "/tmp/annotation-test-export.json" }) };
    },
    initDownloads: ({ getVideo, getClips }) => ({
      refresh: () => refreshes.push(getVideo()?.video_id ?? null),
      open: (clip) => downloadOpens.push({ video_id: getVideo()?.video_id, clip }),
      openAll: () => downloadOpens.push({ video_id: getVideo()?.video_id, clips: getClips() }),
    }),
  });
  vm.runInContext(`${appSource}\nglobalThis.workspaceAPI = {
    addVideo, selectVideo, editClip, saveClip, exportProject,
    state: () => ({ project, activeId, editingId, drafts, player, playerReady, mediaDuration, playerGeneration, storageBlocked, memoryNeedsBackup }),
  };`, context, { filename: "app.js" });
  const api = context.workspaceAPI;
  const node = document.getElementById;
  const libraryRow = (id) => node("video-list").children.find((row) => row.dataset.videoId === api.state().project.videos.find((video) => video.video_id === id)?.id);
  const libraryItem = (id) => libraryRow(id)?.querySelector(".video-item");
  const deleteButton = (id) => libraryRow(id)?.querySelector(".delete-video-button");
  const confirm = (accept) => node(accept ? "confirm-accept" : "confirm-cancel").fire("click");
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  function resolveAPI() {
    window.YT = {
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 },
      Player: class {
        constructor(iframe, options) {
          this.iframe = iframe;
          this.events = options.events;
          this.videoId = new URL(iframe.src).pathname.split("/").at(-1);
          this.time = 0;
          this.duration = this.videoId === "M7lc1UVf-VE" ? 120 : 300;
          instances.push(this);
        }
        getCurrentTime() { return this.time; }
        getDuration() { return this.duration; }
        getVideoData() { return this.title ? { title: this.title } : {}; }
        destroy() { this.destroyed = true; this.iframe.remove(); }
        ready() { this.events.onReady({ target: this }); }
        fail(code = 150) { this.events.onError({ target: this, data: code }); }
        seekTo(time) { this.time = time; }
      },
    };
    window.onYouTubeIframeAPIReady?.();
  }
  function fill(start, end, note, tags = "") {
    for (const [id, value] of Object.entries({ "clip-start": start, "clip-end": end, "clip-note": note, "clip-tags": tags })) node(id).value = value;
  }
  return { api, node, storage, instances, refreshes, downloadOpens, exports, blobs, libraryItem, deleteButton, confirm, flush, resolveAPI, fill, window, document, advanceTime: (milliseconds) => { now += milliseconds; } };
}

test("library clicks preserve distinct saved clips and unfinished per-video drafts before YouTube loads", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.fill("1", "5", "Video A saved", "A");
  h.api.saveClip();
  h.fill("6", "7", "Video A draft");
  h.api.addVideo("dQw4w9WgXcQ");
  assert.equal(h.node("clip-note").value, "");
  h.fill("20", "25", "Video B saved", "B");
  h.api.saveClip();
  h.fill("30", "35", "Video B draft");
  await h.libraryItem("M7lc1UVf-VE").fire("click");
  assert.equal(h.node("clip-note").value, "Video A draft");
  assert.match(h.node("clips-body").textContent, /Video A saved/);
  assert.doesNotMatch(h.node("clips-body").textContent, /Video B saved/);
  await h.libraryItem("dQw4w9WgXcQ").fire("click");
  assert.equal(h.node("clip-note").value, "Video B draft");
  assert.match(h.node("clips-body").textContent, /Video B saved/);
  assert.equal(h.refreshes.at(-1), "dQw4w9WgXcQ");
  assert.equal(h.api.state().playerReady, false);
  core.validateProject(h.api.state().project);
});

test("a slow shared API load constructs only the latest selected player", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.api.addVideo("dQw4w9WgXcQ");
  await h.libraryItem("M7lc1UVf-VE").fire("click");
  h.resolveAPI();
  await h.flush();
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].videoId, "M7lc1UVf-VE");
  h.instances[0].ready();
  assert.equal(h.api.state().mediaDuration, 120);
  assert.equal(h.api.state().playerReady, true);
});

test("late callbacks from a destroyed player cannot change the selected video or controls", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.resolveAPI();
  await h.flush();
  const previous = h.instances[0];
  previous.ready();
  h.api.addVideo("dQw4w9WgXcQ");
  await h.flush();
  const current = h.instances[1];
  current.ready();
  previous.ready();
  previous.fail();
  assert.equal(previous.destroyed, true);
  assert.equal(h.api.state().player, current);
  assert.equal(h.api.state().mediaDuration, 300);
  assert.equal(h.api.state().playerReady, true);
  assert.equal(h.node("player-notice").hidden, true);
  assert.match(h.node("youtube-mount").children[0].src, /dQw4w9WgXcQ/);
});

test("failed embedding does not prevent switching, manual saves, or clip download actions", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.resolveAPI();
  await h.flush();
  h.instances[0].fail();
  assert.equal(h.api.state().playerReady, false);
  h.api.addVideo("dQw4w9WgXcQ");
  h.fill("10", "15", "Saved while player unavailable");
  h.api.saveClip();
  assert.equal(h.api.state().project.videos[1].clips[0].note, "Saved while player unavailable");
  const actions = h.node("clips-body").children[0].children.at(-1).children[0].children;
  const download = actions.find((button) => /download/i.test(button.attributes["aria-label"]));
  assert.ok(download, "Saved clip has a download action independently of player readiness");
  assert.equal(download.disabled, false);
  await download.fire("click");
  assert.equal(h.downloadOpens.at(-1).video_id, "dQw4w9WgXcQ");
  assert.equal(h.downloadOpens.at(-1).clip.start_seconds, 10);
  await h.libraryItem("M7lc1UVf-VE").fire("click");
  assert.equal(h.refreshes.at(-1), "M7lc1UVf-VE");
  assert.equal(h.node("clip-note").value, "");
});

test("an edited clip draft survives switching without modifying another video's clip", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.fill("1", "5", "Original A");
  h.api.saveClip();
  h.api.addVideo("dQw4w9WgXcQ");
  h.fill("10", "20", "Original B");
  h.api.saveClip();
  const [a, b] = h.api.state().project.videos;
  await h.libraryItem("M7lc1UVf-VE").fire("click");
  await h.api.editClip(a.clips[0]);
  h.fill("2", "6", "Edited A");
  await h.libraryItem("dQw4w9WgXcQ").fire("click");
  h.fill("30", "35", "Unfinished B");
  await h.libraryItem("M7lc1UVf-VE").fire("click");
  assert.equal(h.api.state().editingId, a.clips[0].id);
  assert.equal(h.node("clip-note").value, "Edited A");
  h.api.saveClip();
  assert.equal(a.clips.length, 1);
  assert.equal(a.clips[0].note, "Edited A");
  assert.equal(b.clips[0].note, "Original B");
  await h.libraryItem("dQw4w9WgXcQ").fire("click");
  assert.equal(h.node("clip-note").value, "Unfinished B");
  const restored = workspace(h.storage);
  assert.equal(restored.api.state().activeId, b.id);
  assert.equal(restored.node("clip-note").value, "Unfinished B");
  assert.match(restored.node("clips-body").textContent, /Original B/);
});

test("clicking the selected failed video retries playback without erasing its draft", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.resolveAPI();
  await h.flush();
  h.instances[0].fail();
  h.fill("3", "8", "Keep this draft");
  await h.libraryItem("M7lc1UVf-VE").fire("click");
  await h.flush();
  assert.equal(h.instances.length, 2);
  assert.equal(h.instances[0].destroyed, true);
  assert.equal(h.node("clip-note").value, "Keep this draft");
  assert.equal(h.instances[1].videoId, "M7lc1UVf-VE");
  h.instances[1].ready();
  assert.equal(h.api.state().playerReady, true);
});

test("adding a clip clears the search filter and reveals the new saved row", () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.node("clips-search").value = "does-not-match";
  h.fill("12", "18", "New visible clip");
  h.api.saveClip();
  assert.equal(h.node("clips-search").value, "");
  assert.equal(h.node("clips-table-container").hidden, false);
  assert.equal(h.node("clips-body").children.length, 1);
  assert.match(h.node("clips-body").textContent, /New visible clip/);
  assert.equal(h.node("clips-body").children[0].scrolledIntoView, true);
  assert.equal(h.node("clip-error").hidden, true);
});

test("failed API script loading permits manual work and a later video can connect", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  const script = h.document.head.children.find((node) => node.src === "https://www.youtube.com/iframe_api");
  script.onerror();
  await h.flush();
  assert.equal(h.api.state().playerReady, false);
  assert.match(h.node("player-notice-text").textContent, /Could not load YouTube/);
  h.fill("1", "2", "Saved offline");
  h.api.saveClip();
  h.api.addVideo("dQw4w9WgXcQ");
  h.resolveAPI();
  await h.flush();
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].videoId, "dQw4w9WgXcQ");
  h.instances[0].ready();
  assert.equal(h.api.state().playerReady, true);
  assert.equal(h.api.state().project.videos[0].clips[0].note, "Saved offline");
});

test("player readiness, title, and duration updates preserve clickable library and download nodes", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.fill("1", "5", "Clip A");
  h.api.saveClip();
  h.api.addVideo("dQw4w9WgXcQ");
  h.fill("10", "20", "Clip B");
  h.api.saveClip();
  const buttonA = h.libraryItem("M7lc1UVf-VE");
  const buttonB = h.libraryItem("dQw4w9WgXcQ");
  const row = h.node("clips-body").children[0];
  const downloadButton = row.children.at(-1).children[0].children.find((button) => /download/i.test(button.attributes["aria-label"]));
  const playButton = row.querySelector('[data-action="play-clip"]');
  const assertStableControls = () => {
    assert.equal(h.libraryItem("M7lc1UVf-VE"), buttonA);
    assert.equal(h.libraryItem("dQw4w9WgXcQ"), buttonB);
    assert.equal(h.node("clips-body").children[0], row);
    assert.ok(row.contains(downloadButton));
    assert.equal(row.querySelector('[data-action="play-clip"]'), playButton);
  };
  assert.equal(playButton.disabled, true);
  h.resolveAPI();
  await h.flush();
  const player = h.instances[0];
  player.title = "Title learned after the user pressed a button";
  player.ready();
  assertStableControls();
  assert.equal(playButton.disabled, false);
  assert.equal(buttonB.querySelector(".video-item-title").textContent, player.title);
  assert.equal(buttonB.attributes["aria-label"], `Select video: ${player.title}`);
  assert.match(buttonB.querySelector(".video-item-detail").textContent, /05:00/);
  h.advanceTime(4000);
  player.duration = 320;
  player.events.onStateChange({ target: player, data: 1 });
  assertStableControls();
  assert.equal(h.api.state().project.videos[1].duration_seconds, 320);
  assert.match(buttonB.querySelector(".video-item-detail").textContent, /05:20/);
  player.fail();
  assertStableControls();
  assert.equal(playButton.disabled, true);
  assert.equal(downloadButton.disabled, false);
  await downloadButton.fire("click");
  assert.equal(h.downloadOpens.at(-1).video_id, "dQw4w9WgXcQ");
  assert.equal(h.downloadOpens.at(-1).clip.note, "Clip B");
  await buttonA.fire("click");
  assert.equal(h.api.state().activeId, h.api.state().project.videos[0].id);
  assert.match(h.node("clips-body").textContent, /Clip A/);
});

test("canceling a library deletion preserves the video, player, clips, draft, and storage", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.fill("1", "5", "Saved A");
  h.api.saveClip();
  h.fill("6", "8", "Unfinished A");
  h.resolveAPI();
  await h.flush();
  h.instances[0].ready();
  const before = JSON.stringify(h.api.state().project);
  const saved = [...h.storage];
  const select = h.libraryItem("M7lc1UVf-VE");
  const remove = h.deleteButton("M7lc1UVf-VE");
  assert.equal(select.contains(remove), false, "Selection and delete are separate buttons");
  assert.equal(remove.type, "button");
  const pending = remove.fire("click");
  assert.equal(h.node("confirm-dialog").open, true);
  assert.match(h.node("confirm-message").textContent, /1 saved clip.*unfinished draft/s);
  assert.match(h.node("confirm-message").textContent, /Downloaded files, existing JSON exports, and running downloads will not be changed/);
  await h.confirm(false);
  await pending;
  assert.equal(JSON.stringify(h.api.state().project), before);
  assert.deepEqual([...h.storage], saved);
  assert.equal(h.api.state().player, h.instances[0]);
  assert.equal(h.instances[0].destroyed, undefined);
  assert.equal(h.node("clip-note").value, "Unfinished A");
});

test("deleting an inactive video preserves the active player and draft and removes it from persisted exports", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.fill("1", "5", "A saved");
  h.api.saveClip();
  h.fill("6", "8", "A draft");
  const removedId = h.api.state().activeId;
  h.api.addVideo("dQw4w9WgXcQ");
  h.fill("10", "20", "B saved");
  h.api.saveClip();
  h.fill("30", "35", "B draft");
  h.resolveAPI();
  await h.flush();
  const player = h.instances[0];
  player.ready();
  player.time = 42;
  const generation = h.api.state().playerGeneration;
  const row = h.node("clips-body").children[0];
  const pending = h.deleteButton("M7lc1UVf-VE").fire("click");
  await h.confirm(true);
  await pending;
  assert.equal(h.api.state().player, player);
  assert.equal(h.api.state().playerGeneration, generation);
  assert.equal(player.time, 42);
  assert.equal(h.node("clip-note").value, "B draft");
  assert.equal(h.node("clips-body").children[0], row);
  assert.equal(h.api.state().drafts[removedId], undefined);
  assert.equal(h.api.state().project.videos.length, 1);
  const stored = core.validateProject(JSON.parse(h.storage.get(core.STORAGE_KEY)));
  assert.equal(stored.videos[0].video_id, "dQw4w9WgXcQ");
  const workspaceData = JSON.parse(h.storage.get(`${core.STORAGE_KEY}.workspace`));
  assert.equal(workspaceData.drafts[removedId], undefined);
  assert.equal(workspaceData.drafts[stored.videos[0].id].note, "B draft");
  h.api.saveClip();
  await h.api.exportProject();
  assert.equal(h.exports.length, 1);
  const exported = core.validateProject(h.exports[0]);
  assert.equal(exported.videos.length, 1);
  assert.equal(exported.videos[0].video_id, "dQw4w9WgXcQ");
  assert.equal(exported.videos[0].clips.length, 2);
});

test("active deletion selects the next video, then the previous video, restoring each draft", async () => {
  const h = workspace();
  for (const [id, label] of [["M7lc1UVf-VE", "A"], ["dQw4w9WgXcQ", "B"], ["jNQXAC9IVRw", "C"]]) {
    h.api.addVideo(id);
    h.fill("1", "5", `${label} saved`);
    h.api.saveClip();
    h.fill("6", "8", `${label} draft`);
  }
  await h.libraryItem("dQw4w9WgXcQ").fire("click");
  h.resolveAPI();
  await h.flush();
  const previous = h.instances[0];
  previous.ready();
  let pending = h.deleteButton("dQw4w9WgXcQ").fire("click");
  await h.confirm(true);
  await pending;
  await h.flush();
  assert.equal(previous.destroyed, true);
  assert.equal(h.api.state().project.videos.find((video) => video.id === h.api.state().activeId).video_id, "jNQXAC9IVRw");
  assert.equal(h.node("clip-note").value, "C draft");
  assert.match(h.node("clips-body").textContent, /C saved/);
  h.instances[1].ready();
  previous.ready();
  previous.fail();
  assert.equal(h.api.state().player, h.instances[1]);
  assert.equal(h.node("player-notice").hidden, true);
  pending = h.deleteButton("jNQXAC9IVRw").fire("click");
  await h.confirm(true);
  await pending;
  assert.equal(h.api.state().project.videos[0].video_id, "M7lc1UVf-VE");
  assert.equal(h.api.state().activeId, h.api.state().project.videos[0].id);
  assert.equal(h.node("clip-note").value, "A draft");
  assert.match(h.node("clips-body").textContent, /A saved/);
});

test("deleting the last video clears player and editor state, ignores stale callbacks, and permits adding another", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.fill("1", "5", "Last saved clip");
  h.api.saveClip();
  await h.api.editClip(h.api.state().project.videos[0].clips[0]);
  h.fill("2", "6", "Discard this edit with the video");
  h.resolveAPI();
  await h.flush();
  const previous = h.instances[0];
  previous.ready();
  const pending = h.deleteButton("M7lc1UVf-VE").fire("click");
  await h.confirm(true);
  await pending;
  const state = h.api.state();
  assert.equal(state.activeId, null);
  assert.equal(state.editingId, null);
  assert.equal(state.player, null);
  assert.equal(state.playerReady, false);
  assert.equal(state.mediaDuration, 0);
  assert.equal(Object.keys(state.drafts).length, 0);
  assert.equal(previous.destroyed, true);
  assert.equal(h.node("youtube-mount").children.length, 0);
  assert.equal(h.node("youtube-mount").hidden, true);
  assert.equal(h.node("video-empty").hidden, false);
  assert.equal(h.node("video-list").children.length, 0);
  assert.equal(h.node("clips-body").children.length, 0);
  assert.equal(h.node("clip-note").value, "");
  for (const id of ["clip-fields", "video-title", "capture-start", "capture-end", "play-toggle", "seek-range", "export-button"]) assert.equal(h.node(id).disabled, true, id);
  assert.equal(h.refreshes.at(-1), null, "Download controls receive the empty selection");
  assert.equal(h.node("current-time").textContent, "00:00.000");
  assert.equal(h.node("video-duration").textContent, "--:--");
  previous.ready();
  previous.fail();
  previous.events.onStateChange({ target: previous, data: 1 });
  assert.equal(h.api.state().player, null);
  assert.equal(h.node("player-notice").hidden, true);
  assert.equal(core.validateProject(JSON.parse(h.storage.get(core.STORAGE_KEY))).videos.length, 0);
  const restored = workspace(h.storage);
  assert.equal(restored.api.state().activeId, null);
  assert.equal(restored.node("clip-note").value, "");
  h.api.addVideo("dQw4w9WgXcQ");
  await h.flush();
  h.instances[1].ready();
  assert.equal(h.api.state().playerReady, true);
  assert.equal(h.node("clip-fields").disabled, false);
  h.fill("10", "12", "New video clip");
  h.api.saveClip();
  assert.equal(h.api.state().project.videos.length, 1);
  assert.equal(h.api.state().project.videos[0].video_id, "dQw4w9WgXcQ");
  assert.equal(h.api.state().project.videos[0].clips[0].note, "New video clip");
});

test("deleting the last video while the API is pending prevents its player from being resurrected", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  const pending = h.deleteButton("M7lc1UVf-VE").fire("click");
  await h.confirm(true);
  await pending;
  h.resolveAPI();
  await h.flush();
  assert.equal(h.instances.length, 0);
  assert.equal(h.node("youtube-mount").children.length, 0);
  assert.equal(h.api.state().activeId, null);
  h.api.addVideo("jNQXAC9IVRw");
  await h.flush();
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].videoId, "jNQXAC9IVRw");
});

test("the sidebar toggles accessibly and remembers its layout without changing annotation data", async () => {
  const h = workspace();
  h.api.addVideo("M7lc1UVf-VE");
  h.fill("1", "5", "Saved clip");
  h.api.saveClip();
  h.fill("6", "8", "Keep the draft");
  await h.node("clip-note").fire("input");
  h.resolveAPI();
  await h.flush();
  h.instances[0].ready();
  const projectBefore = h.storage.get(core.STORAGE_KEY);
  const workspaceBefore = h.storage.get(`${core.STORAGE_KEY}.workspace`);
  const player = h.api.state().player;
  const select = h.libraryItem("M7lc1UVf-VE");
  const toggle = h.node("sidebar-toggle");
  assert.equal(toggle.attributes["aria-controls"], "sidebar-content");
  assert.equal(toggle.attributes["aria-expanded"], "true");
  await toggle.fire("click");
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.equal(toggle.attributes["aria-label"], "Expand video library");
  assert.equal(h.node("sidebar-content").hidden, true);
  assert.equal(toggle.hidden, false, "The reopen control remains available");
  assert.ok(h.document.body.className.split(" ").includes("sidebar-collapsed"));
  assert.equal(h.storage.get(sidebarStorageKey), "true");
  assert.equal(h.storage.get(core.STORAGE_KEY), projectBefore);
  assert.equal(h.storage.get(`${core.STORAGE_KEY}.workspace`), workspaceBefore);
  assert.equal(h.api.state().player, player);
  assert.equal(h.libraryItem("M7lc1UVf-VE"), select);
  assert.equal(h.node("clip-note").value, "Keep the draft");
  const restored = workspace(h.storage);
  assert.equal(restored.node("sidebar-content").hidden, true);
  assert.equal(restored.node("clip-note").value, "Keep the draft");
  await restored.node("sidebar-toggle").fire("click");
  assert.equal(restored.node("sidebar-content").hidden, false);
  assert.equal(restored.node("sidebar-toggle").attributes["aria-label"], "Collapse video library");
  assert.equal(restored.storage.get(sidebarStorageKey), "false");
});

test("sidebar preference events and failures do not disable or bypass project autosave", async () => {
  const h = workspace([], { failSidebarStorage: true });
  h.api.addVideo("M7lc1UVf-VE");
  await h.node("sidebar-toggle").fire("click");
  assert.equal(h.node("sidebar-content").hidden, true);
  assert.equal(h.api.state().storageBlocked, false);
  assert.equal(h.storage.has(sidebarStorageKey), false);
  h.window.fire("storage", { key: sidebarStorageKey, newValue: "true" });
  assert.equal(h.api.state().storageBlocked, false);
  h.fill("1", "5", "Still autosaved");
  h.api.saveClip();
  assert.equal(core.validateProject(JSON.parse(h.storage.get(core.STORAGE_KEY))).videos[0].clips[0].note, "Still autosaved");
  assert.equal(h.api.state().memoryNeedsBackup, false);
  h.window.fire("storage", { key: core.STORAGE_KEY, newValue: "another tab changed it" });
  assert.equal(h.api.state().storageBlocked, true);
  await h.node("sidebar-toggle").fire("click");
  assert.equal(h.api.state().storageBlocked, true, "Changing layout must not release the cross-tab safety lock");
  assert.equal(h.api.state().memoryNeedsBackup, true);
});

test("collapsing sidebar content returns keyboard focus to its visible toggle", async () => {
  const h = workspace();
  h.node("sidebar-content").append(h.node("project-name"));
  h.node("project-name").focus();
  await h.node("sidebar-toggle").fire("click");
  assert.equal(h.document.activeElement, h.node("sidebar-toggle"));
  assert.equal(h.node("sidebar-content").hidden, true);
});

test("Pages exports valid annotation JSON through the browser without calling the local backend", async () => {
  const h = workspace([], { mode: "static" });
  h.api.addVideo("M7lc1UVf-VE");
  h.fill("1.125", "6.125", "Corpus note / 中文", "speech, gesture");
  h.api.saveClip();
  await h.api.exportProject();
  assert.equal(h.exports.length, 0, "Pages must not POST to /api/exports");
  assert.equal(h.document.downloads.length, 1);
  const download = h.document.downloads[0];
  assert.match(download.filename, /\.json$/);
  const raw = JSON.parse(await h.blobs.get(download.url).text());
  assert.equal(typeof raw.exported_at, "string");
  const exported = core.validateProject(raw);
  assert.deepEqual(exported, core.validateProject(JSON.parse(JSON.stringify(h.api.state().project))));
  assert.equal(exported.videos[0].clips[0].note, "Corpus note / 中文");
  assert.equal(exported.videos[0].clips[0].start_seconds, 1.125);
  assert.equal(h.node("export-path-container").hidden, true);
  assert.equal(h.node("export-button").disabled, false);
});

test("local mode continues saving exported annotations through the backend", async () => {
  const h = workspace([], { mode: "local" });
  h.api.addVideo("M7lc1UVf-VE");
  h.fill("2", "7", "Saved through local server");
  h.api.saveClip();
  await h.api.exportProject();
  assert.equal(h.exports.length, 1);
  assert.equal(h.document.downloads.length, 0);
  assert.equal(core.validateProject(h.exports[0]).videos[0].clips[0].note, "Saved through local server");
  assert.equal(h.node("export-path-container").hidden, false);
  assert.equal(h.node("export-path").value, "/tmp/annotation-test-export.json");
});

test("question drafts autosave across videos/reload and survive clip edits and export", async () => {
  const w=workspace(); w.api.addVideo("M7lc1UVf-VE"); w.fill("0","10","clip note"); w.api.saveClip();
  await w.node("qa-add").click();
  const descendants=(node)=>node.children.flatMap(child=>[child,...descendants(child)]);
  const field=descendants(w.node("qa-editor")).find(n=>n.attributes["aria-label"]==="Question");
  field.value="Who speaks next?"; await field.fire("input");
  await w.node("qa-add").click();
  const firstVideo=w.api.state().project.videos[0];
  assert.equal(firstVideo.clips[0].questions.length,2);
  w.api.addVideo("jNQXAC9IVRw"); w.fill("1","3","second clip"); w.api.saveClip();
  await w.node("qa-add").click();
  assert.equal(w.api.state().project.videos[1].clips[0].questions.length,1);
  w.api.selectVideo(firstVideo.id);
  await w.api.editClip(firstVideo.clips[0]); w.fill("0","11","updated note"); w.api.saveClip();
  assert.equal(firstVideo.clips[0].questions[0].prompt,"Who speaks next?");
  const restored=workspace([...w.storage]);
  assert.equal(restored.api.state().project.videos[0].clips[0].questions.length,2);
  await restored.api.exportProject();
  assert.equal(restored.exports[0].videos[0].clips[0].questions[0].prompt,"Who speaks next?");
});

test("clips and questions record their author, keep it across edits and profile changes, and show it in the UI", async () => {
  const w = workspace();
  w.node("annotator-name").value = "Nan"; await w.node("annotator-name").fire("input");
  w.api.addVideo("M7lc1UVf-VE"); w.fill("0", "10", "first"); w.api.saveClip();
  await w.node("qa-add").click();
  w.node("annotator-name").value = "Leixin"; await w.node("annotator-name").fire("input");
  await w.node("qa-add").click();
  const clip = w.api.state().project.videos[0].clips[0];
  assert.deepEqual(clip.annotator, { id: "", name: "Nan" });
  assert.deepEqual(clip.questions.map((q) => q.annotator.name), ["Nan", "Leixin"]);
  await w.api.editClip(clip); w.fill("1", "10", "edited by Leixin"); w.api.saveClip();
  const edited = w.api.state().project.videos[0].clips[0];
  assert.equal(edited.note, "edited by Leixin");
  assert.deepEqual(edited.annotator, { id: "", name: "Nan" }, "editing must not reassign the clip author");
  const row = w.node("clips-body").children[0];
  assert.equal(row.children[3].querySelector(".clip-annotator").textContent, "Nan");
  assert.equal(row.children[3].querySelector(".clip-annotator-more").textContent, "+ questions by Leixin");
  const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
  assert.deepEqual(w.node("qa-list").querySelectorAll(".qa-question-author").map((n) => n.textContent), ["Nan", "Leixin"]);
  assert.ok(descendants(w.node("qa-editor")).some((n) => n.textContent === "Written by Nan" || n.textContent === "Written by Leixin"));
  w.node("clips-search").value = "leixin"; await w.node("clips-search").fire("input");
  assert.equal(w.node("clips-body").children.length, 1, "clip search matches question authors");
  await w.api.exportProject();
  const exported = core.validateProject(w.exports[0]);
  assert.equal(exported.schema_version, "1.2");
  assert.equal(exported.videos[0].clips[0].annotator.name, "Nan");
});

test("library filters narrow the video list without changing the project or the active video", async () => {
  const w = workspace();
  w.node("annotator-name").value = "Nan"; await w.node("annotator-name").fire("input");
  w.api.addVideo("M7lc1UVf-VE"); w.fill("0", "10", "a", "range-fix"); w.api.saveClip();
  w.node("annotator-name").value = "Erik"; await w.node("annotator-name").fire("input");
  w.api.addVideo("jNQXAC9IVRw"); w.fill("0", "5", "b"); w.api.saveClip();
  await w.node("qa-add").click();
  w.api.addVideo("dQw4w9WgXcQ");
  const visibleIds = () => w.node("video-list").children.map((row) => row.dataset.videoId).filter(Boolean)
    .map((id) => w.api.state().project.videos.find((v) => v.id === id).video_id);
  assert.equal(w.node("library-filters").hidden, false);
  assert.deepEqual(visibleIds(), ["M7lc1UVf-VE", "jNQXAC9IVRw", "dQw4w9WgXcQ"]);
  assert.equal(w.node("library-filter-summary").hidden, true);
  const erik = w.node("library-annotator").children.find((o) => o.textContent === "Erik");
  w.node("library-annotator").value = erik.value; await w.node("library-annotator").fire("change");
  assert.deepEqual(visibleIds(), ["jNQXAC9IVRw"]);
  assert.equal(w.node("library-filter-count").textContent, "1 of 3 videos");
  w.node("library-annotator").value = ""; await w.node("library-annotator").fire("change");
  w.node("library-tag").value = "range-fix"; await w.node("library-tag").fire("change");
  assert.deepEqual(visibleIds(), ["M7lc1UVf-VE"]);
  w.node("library-status").value = "has-drafts"; await w.node("library-status").fire("change");
  assert.deepEqual(visibleIds(), []);
  assert.equal(w.node("video-list").children[0].textContent, "No videos match these filters.");
  await w.node("clear-library-filters").click();
  assert.deepEqual(visibleIds(), ["M7lc1UVf-VE", "jNQXAC9IVRw", "dQw4w9WgXcQ"]);
  w.node("library-search").value = "dQw4"; await w.node("library-search").fire("input");
  assert.deepEqual(visibleIds(), ["dQw4w9WgXcQ"]);
  assert.equal(w.api.state().project.videos.length, 3);
  assert.equal(w.api.state().project.videos.find((v) => v.id === w.api.state().activeId).video_id, "dQw4w9WgXcQ");
});
