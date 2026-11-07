import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { captureScrollingPage, captureVisiblePage, pageCaptureCommand } from "../extension/scroll-capture.js";

function fixture(total = 1800) {
  const tab = { id: 17, windowId: 8, url: "https://example.com/job" };
  let top = 0;
  const commands = [];
  const captured = [];
  let active = { ...tab };
  const chromeApi = {
    scripting: { executeScript: async ({ args }) => {
      const [, command, offset] = args;
      commands.push(command);
      if (command === "begin") top = 0;
      if (command === "scroll") top = offset;
      return [{ result: command === "restore" ? null : {
        top, height: 800, total, rect: { left: 100, top: 0, width: 600, height: 800 },
        viewportWidth: 1000, viewportHeight: 800,
      } }];
    } },
    tabs: {
      query: async () => [active],
      captureVisibleTab: async (windowId) => {
        assert.equal(windowId, 8);
        captured.push(top);
        return "data:image/jpeg;base64,AAAA";
      },
    },
  };
  return { tab, chromeApi, commands, captured, switchTab: () => { active = { ...tab, id: 99 }; } };
}

test("scrolls top to bottom with overlap, preserves sequence and restores page", async () => {
  const f = fixture();
  const received = [];
  const waits = [];
  const count = await captureScrollingPage({ ...f, maxImages: 12,
    wait: async ms => waits.push(ms), onImage: async (_image, state) => received.push(state.top),
  });
  assert.equal(count, 3);
  assert.deepEqual(received, [0, 680, 1000]);
  assert.deepEqual(f.captured, received);
  assert.ok(waits.every(ms => ms >= 500));
  assert.equal(f.commands.at(-1), "restore");
});

test("GoFullPage mode uses upstream bottom-up plan and reports sampling progress", async () => {
  const f = fixture();
  const progress = [];
  const count = await captureScrollingPage({ ...f, mode: "gofullpage", maxImages: 12,
    wait: async () => {}, onImage: async () => {},
    onProgress: (_count, state) => progress.push(state.captureProgress),
  });
  assert.equal(count, 3);
  assert.deepEqual(f.captured, [1000, 400, 0]);
  assert.deepEqual(progress, [1 / 3, 2 / 3, 1]);
  assert.equal(f.commands.at(-1), "restore");
});

test("screenshot limit rejects incomplete capture instead of successful completion", async () => {
  const f = fixture(50000);
  await assert.rejects(captureScrollingPage({ ...f, maxImages: 2, wait: async () => {}, onImage: async () => {} }), /上限/);
  assert.equal(f.captured.length, 2);
  assert.equal(f.commands.at(-1), "restore");
});

test("switching tabs prevents capture of the wrong page and restores target", async () => {
  const f = fixture();
  await assert.rejects(captureScrollingPage({ ...f, maxImages: 12,
    wait: async () => f.switchTab(), onImage: async () => assert.fail("must not accept unrelated page"),
  }), /切换/);
  assert.equal(f.captured.length, 0);
  assert.equal(f.commands.at(-1), "restore");
});

test("cancelled scroll capture restores page without capturing another frame", async () => {
  const f = fixture();
  const controller = new AbortController();
  await assert.rejects(captureScrollingPage({ ...f, maxImages: 12, signal: controller.signal,
    wait: async () => controller.abort(), onImage: async () => assert.fail("cancelled"),
  }), error => error.name === "AbortError");
  assert.equal(f.captured.length, 0);
  assert.equal(f.commands.at(-1), "restore");
});

test("image processing failure restores scroll and rejects whole pipeline", async () => {
  const f = fixture();
  await assert.rejects(captureScrollingPage({ ...f, maxImages: 12, wait: async () => {},
    onImage: async () => { throw new Error("图片超出大小限制"); },
  }), /大小限制/);
  assert.equal(f.commands.at(-1), "restore");
});

test("visible capture works without scripting permission or model configuration", async () => {
  const f = fixture();
  delete f.chromeApi.scripting;
  let count = 0;
  await captureVisiblePage({ ...f, wait: async () => {}, onImage: async image => {
    assert.match(image, /^data:image/);
    count++;
  } });
  assert.equal(count, 1);
  assert.deepEqual(f.commands, []);
});

test("an unresponsive capture reports timeout instead of waiting indefinitely", async () => {
  const f = fixture();
  f.chromeApi.tabs.captureVisibleTab = () => new Promise(() => {});
  await assert.rejects(captureScrollingPage({ ...f, maxImages: 12, timeoutMs: 15,
    wait: async () => {}, onImage: async () => assert.fail("no pixels"),
  }), /截取页面图片等待超时/);
  assert.equal(f.commands.at(-1), "restore");
});

test("nested JD scroll area wins over a larger document and restores its styles and positions", () => {
  function element({ text = "", height, total = height, top = 0, parent = null, overflow = "visible" }) {
    const styles = new Map([["scroll-snap-type", ["y mandatory", ""]]]);
    const el = {
      innerText: text, clientHeight: height, scrollHeight: total, scrollTop: top, scrollLeft: 0,
      parentElement: parent, isConnected: true, overflow,
      getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: height, height, width: 800 }),
      style: {
        getPropertyValue: name => styles.get(name)?.[0] || "",
        getPropertyPriority: name => styles.get(name)?.[1] || "",
        setProperty: (name, value, priority) => styles.set(name, [value, priority]),
        removeProperty: name => styles.delete(name),
      },
      scrollTo: ({ top, left }) => { el.scrollTop = top; el.scrollLeft = left; },
      scrollIntoView: () => {},
      contains: child => { for (let p = child; p; p = p.parentElement) if (p === el) return true; return false; },
    };
    return el;
  }
  const root = element({ text: "职位描述".repeat(3000), height: 800, total: 6000, top: 200 });
  const scroll = element({ text: "职位描述".repeat(100), height: 600, total: 1800, top: 160, parent: root, overflow: "auto" });
  const section = element({ text: "职位描述 任职要求".repeat(50), height: 1800, parent: scroll });
  const heading = element({ text: "职位描述", height: 24, parent: section });
  const context = {
    window: {}, document: { scrollingElement: root, body: root, querySelectorAll: () => [heading] },
    innerWidth: 1000, innerHeight: 800, getComputedStyle: el => ({ overflowY: el.overflow }),
  };
  const run = (command, offset = 0) => vm.runInNewContext(`(${pageCaptureCommand.toString()})("test", "${command}", ${offset})`, context);
  const state = run("begin");
  assert.equal(context.window.test.element, scroll);
  assert.equal(state.height, 600);
  assert.equal(state.total, 1800);
  assert.equal(scroll.scrollTop, 0);
  run("scroll", 680);
  assert.equal(scroll.scrollTop, 680);
  run("restore");
  assert.equal(scroll.scrollTop, 160);
  assert.equal(root.scrollTop, 200);
  assert.equal(scroll.style.getPropertyValue("scroll-snap-type"), "y mandatory");
  assert.equal(context.window.test, undefined);
});
