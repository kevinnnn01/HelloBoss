import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as core from "../extension/core.js";
import { GoFullPageCompositor } from "../extension/vendor/gofullpage/capture-core.js";

// Exercise the actual sidebar click handler in a simulated extension context.
// Browser pixels/API grants remain mocked; this is not a real Chrome acceptance test.
const scenarios = [
  { mode: "auto" }, { mode: "gofullpage" },
  { mode: "auto", grant: "allow" }, { mode: "auto", grant: "deny" },
  { mode: "auto", grant: "error" }, { mode: "auto", captureError: true },
  { mode: "gofullpage", autoCopy: true }, { mode: "gofullpage", autoCopy: true, clipboardError: true },
  { mode: "gofullpage", autoCopy: true, clipboardError: true, backgroundCopy: true },
];
for (const { mode, grant, captureError, autoCopy, clipboardError, backgroundCopy } of scenarios) test(`${mode}: sidebar ${autoCopy ? (backgroundCopy ? "background clipboard fallback" : clipboardError ? "clipboard failure" : "auto-copy") : grant || (captureError ? "capture permission error" : "capture preview without model")}`, async () => {
  function node() {
    return {
      value: "", textContent: "", children: [], checked: false, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute() {}, append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; }, scrollIntoView() {},
      focus() {}, select() {},
    };
  }
  const html = readFileSync(new URL("../extension/panel.html", import.meta.url), "utf8");
  const elements = Object.fromEntries(Array.from(html.matchAll(/id="([^"]+)"/g), match => [match[1], node()]));
  elements["capture-mode"].value = mode;
  elements["auto-generate"].checked = true;
  let captures = 0;
  let modelRequests = 0;
  let capturePermissionRequests = 0;
  const copied = [];
  class Reader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(bytes => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
        this.onload();
      });
    }
  }
  class Canvas {
    getContext() { return { drawImage() {} }; }
    async convertToBlob() { return new Blob(["simulated-pixels"], { type: "image/jpeg" }); }
  }
  const tab = { id: 17, windowId: 8, title: "测试岗位", url: "https://example.com/job" };
  const chrome = {
    runtime: {
      getManifest: () => ({ version: "0.4.6" }),
      async sendMessage({ type, text }) {
        assert.equal(type, "copy-greeting");
        if (backgroundCopy) copied.push(text);
        return { copied: Boolean(backgroundCopy) };
      },
    },
    scripting: {},
    storage: {
      local: { setAccessLevel: async () => {}, get: async () => ({}), set: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
    },
    tabs: { query: async () => [tab] },
    permissions: {
      request: async ({ origins }) => {
        if (origins.includes("<all_urls>")) {
          capturePermissionRequests++;
          if (grant === "error") throw new Error("permission is not declared");
          return grant === "allow";
        }
        modelRequests++;
        return true;
      },
      contains: async () => true,
    },
  };
  const context = {
    ...core, chrome, AbortController, Blob, File, FileReader: Reader, setTimeout, clearTimeout, URL,
    navigator: { clipboard: { async writeText(value) {
      if (clipboardError) throw new Error("clipboard unavailable");
      copied.push(value);
    } } },
    generateGreeting: async input => {
      assert.equal(input.images.length, 1);
      return { greeting: "我是金融科技专业应届生。", notes: ["内部提示"] };
    },
    GoFullPageCompositor: class extends GoFullPageCompositor {
      constructor() { super({ canvasFactory: () => new Canvas() }); }
    },
    document: {
      getElementById: id => elements[id], createElement: node, addEventListener() {},
    },
    fetch: url => {
      assert.match(url, /^data:image\//);
      return fetch(url);
    },
    createImageBitmap: async () => ({ width: 800, height: 600, close() {} }),
    OffscreenCanvas: Canvas,
    captureScrollingPage: async ({ onImage, onProgress }) => {
      captures++;
      if (captureError) throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
      const state = { viewportWidth: 800, viewportHeight: 600,
        rect: { left: 0, top: 0, width: 800, height: 600 }, top: 0, height: 600, total: 600 };
      await onImage("data:image/jpeg;base64,AAAA", state, 0);
      onProgress(1, state);
    },
  };
  const source = readFileSync(new URL("../extension/panel.js", import.meta.url), "utf8")
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];/g, "");
  vm.runInNewContext(source, context);
  await new Promise(setImmediate); // configuration hydration
  if (autoCopy) {
    elements["api-key"].value = "test-key";
    elements.experience.value = "金融科技专业应届生";
    await elements.capture.listeners.click();
    assert.equal(captures, 1);
    assert.equal(elements.greeting.value, "我是金融科技专业应届生。");
    const copyFailed = clipboardError && !backgroundCopy;
    assert.deepEqual(copied, copyFailed ? [] : [elements.greeting.value]);
    assert.match(elements["activity-status"].textContent, copyFailed ? /剪贴板写入失败/ : /正文已复制/);
    assert.equal(elements.copy.disabled, false);
    return;
  }
  if (grant) {
    const pending = elements["authorize-capture"].listeners.click();
    assert.equal(capturePermissionRequests, 1, "request starts synchronously in click gesture");
    await pending;
    assert.equal(captures, 0, "granting permission does not start screenshot or upload");
    assert.equal(modelRequests, 0);
    assert.match(elements["activity-status"].textContent,
      grant === "allow" ? /截图权限已启用/ : grant === "deny" ? /未授予截图权限/ : /permission is not declared/);
    assert.equal(elements.inputs.disabled, false);
    return;
  }
  await elements.capture.listeners.click();
  assert.equal(captures, 1);
  assert.equal(modelRequests, 0, "missing API key must not prompt for API access");
  assert.equal(capturePermissionRequests, 0, "normal capture never silently requests all sites");
  if (captureError) {
    assert.match(elements["activity-status"].textContent, /启用截图权限/);
    assert.match(elements["activity-status"].textContent, /原始错误：Either/);
    assert.equal(elements.inputs.disabled, false);
    return;
  }
  assert.equal(elements["image-count"].textContent, "1 / 12");
  assert.equal(elements["image-list"].children.length, 1);
  assert.match(elements["activity-status"].textContent, /截图已完成/);
  assert.match(elements["activity-status"].textContent, /API Key/);
  assert.equal(elements.inputs.disabled, false);
});
