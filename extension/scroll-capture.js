import { createCapturePlan } from "./vendor/gofullpage/capture-core.js";

// This self-contained function runs only in the user-invoked tab, in Chrome's isolated world.
export function pageCaptureCommand(key, command, offset = 0, mode = "auto") {
  if (command === "begin") {
    const root = document.scrollingElement;
    if (!root) throw new Error("网页尚未加载完成，请稍后重试。");
    const visible = el => {
      const box = el.getBoundingClientRect();
      return box.width >= 260 && box.height > 20 && box.top < innerHeight && box.bottom > 0 &&
        box.right > 0 && box.left < innerWidth;
    };
    let scope = null;
    let element = root;
    if (mode === "auto") {
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,[class*='title']"))
        .filter(el => visible(el) && /^(职位描述|岗位描述|岗位职责|工作职责|任职要求|职位要求)\s*[:：]?$/.test((el.innerText || "").trim()));
      const heading = headings.find(el => /职位描述|岗位描述/.test(el.innerText)) || headings[0];
      if (heading) {
        const sections = [];
        for (let parent = heading.parentElement; parent && parent !== document.body && parent !== root; parent = parent.parentElement) {
          const box = parent.getBoundingClientRect();
          const text = parent.innerText || "";
          if (box.width >= 260 && box.height >= 180 && text.length > 120) sections.push(parent);
        }
        scope = sections.find(el => /任职要求|职位要求/.test(el.innerText)) || sections[0] || null;
        // The closest scrollable ancestor is more reliable than comparing it with root's area.
        for (let parent = heading.parentElement; parent && parent !== root; parent = parent.parentElement) {
          if (parent.clientHeight >= 180 && parent.scrollHeight > parent.clientHeight + 10 &&
              /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
            element = parent;
            break;
          }
        }
      }
    }
    if (scope && !element.contains(scope)) scope = element;
    const properties = ["scroll-behavior", "scroll-snap-type", "overflow-anchor"];
    window[key] = {
      element, scope, top: element.scrollTop, left: element.scrollLeft,
      root, rootTop: root.scrollTop, rootLeft: root.scrollLeft,
      styles: properties.map(name => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]),
      viewportWidth: innerWidth, viewportHeight: innerHeight,
    };
    element.style.setProperty("scroll-behavior", "auto", "important");
    element.style.setProperty("scroll-snap-type", "none", "important");
    element.style.setProperty("overflow-anchor", "none", "important");
    if (element !== root) element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    element.scrollTo({ top: 0, left: element.scrollLeft, behavior: "instant" });
  }
  const state = window[key];
  if (!state?.element?.isConnected) throw new Error("页面已变化，请在目标岗位页重新截屏。");
  const el = state.element;
  if (command === "restore") {
    el.scrollTo({ top: state.top, left: state.left, behavior: "instant" });
    for (const [name, value, priority] of state.styles) {
      if (value) el.style.setProperty(name, value, priority);
      else el.style.removeProperty(name);
    }
    if (el !== state.root) state.root.scrollTo({ top: state.rootTop, left: state.rootLeft, behavior: "instant" });
    delete window[key];
    return null;
  }
  if (innerWidth !== state.viewportWidth || innerHeight !== state.viewportHeight) {
    throw new Error("截图期间网页可见尺寸发生变化，请保持窗口和侧栏宽度不变后重试。");
  }
  if (command === "scroll") el.scrollTo({ top: offset, left: el.scrollLeft, behavior: "instant" });
  const box = el === document.scrollingElement
    ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : el.getBoundingClientRect();
  let left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  let right = Math.min(innerWidth, box.right);
  let total = el.scrollHeight;
  if (state.scope && state.scope !== el) {
    const scopeBox = state.scope.getBoundingClientRect();
    left = Math.max(left, scopeBox.left);
    right = Math.min(right, scopeBox.right);
    total = Math.min(total, Math.max(el.clientHeight, scopeBox.bottom - box.top + el.scrollTop));
  }
  const width = right - left;
  const height = Math.min(innerHeight, box.bottom) - top;
  if (width < 100 || height < 100) throw new Error("岗位内容区域不可见，请展开岗位详情后重试。");
  if (el !== state.root && el.clientHeight > height + 4) throw new Error("岗位滚动区未完整显示，请展开详情或使用整页模式。");
  return { top: el.scrollTop, height: Math.min(el.clientHeight, height), total,
    label: state.scope ? "岗位详情" : "整个网页",
    rect: { left, top, width, height }, viewportWidth: innerWidth, viewportHeight: innerHeight };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function operation(promise, signal, name, timeoutMs) {
  signal?.throwIfAborted();
  let timer;
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name}等待超时，请关闭并重新打开侧栏后重试。`)), timeoutMs);
        abort = () => reject(signal.reason || new DOMException("已取消", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

async function assertActiveTab(chromeApi, tab, signal, timeoutMs) {
  signal?.throwIfAborted();
  const [active] = await operation(chromeApi.tabs.query({ active: true, windowId: tab.windowId }), signal, "检查目标页面", timeoutMs);
  if (active?.id !== tab.id || (active.url && tab.url && active.url !== tab.url)) {
    throw new Error("截屏期间切换了标签页或页面地址，本次已停止。请回到目标岗位重新截屏。");
  }
}

export async function captureVisiblePage({ chromeApi, tab, onImage, signal, wait = pause, timeoutMs = 10000 }) {
  await wait(700);
  await assertActiveTab(chromeApi, tab, signal, timeoutMs);
  const image = await operation(chromeApi.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 88 }), signal, "截取可见区域", timeoutMs);
  await assertActiveTab(chromeApi, tab, signal, timeoutMs);
  await onImage(image);
  return 1;
}

export async function captureScrollingPage({ chromeApi, tab, maxImages, mode = "auto", onImage, onProgress,
  signal, wait = pause, timeoutMs = 10000 }) {
  const key = `__greeting_capture_${crypto.randomUUID()}`;
  const command = async (action, offset) => {
    const [frame] = await operation(chromeApi.scripting.executeScript({
      target: { tabId: tab.id }, func: pageCaptureCommand, args: [key, action, offset ?? 0, mode === "gofullpage" ? "auto" : mode],
    }), action === "restore" ? undefined : signal, "读取网页滚动状态", timeoutMs);
    if (frame?.error) throw new Error(frame.error.message || "页面滚动失败。");
    if (!frame || (action !== "restore" && !frame.result)) throw new Error("无法读取页面滚动状态。");
    return frame.result;
  };
  const assertTab = () => assertActiveTab(chromeApi, tab, signal, timeoutMs);
  let count = 0;
  try {
    await assertTab();
    const initial = await command("begin");
    if (mode === "gofullpage") {
      const plan = createCapturePlan(initial.rect.width, initial.total, initial.rect.width, initial.height);
      if (plan.length > maxImages) throw new Error(`GoFullPage：需要 ${plan.length} 帧，超过 ${maxImages} 帧上限，请缩短岗位内容。`);
      for (const [, offset] of plan) {
        await command("scroll", offset);
        await wait(700);
        await assertTab();
        const state = await command("read");
        if (Math.abs(state.total - initial.total) > 2 || Math.abs(state.top - offset) > 2) {
          throw new Error("GoFullPage：页面高度变化或滚动未到位，请等待页面加载完成后重试。");
        }
        const dataUrl = await operation(chromeApi.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 88 }), signal, "GoFullPage 截取图片", timeoutMs);
        await assertTab();
        await onImage(dataUrl, state, count);
        count++;
        onProgress?.(count, { ...state, label: `GoFullPage · ${state.label || "网页"}`, captureProgress: count / plan.length });
      }
      return count;
    }
    let lastTop = -1;
    while (count < maxImages) {
      // Above Chrome's 2 captures/second limit; also allows scroll/lazy content to settle.
      await wait(700);
      await assertTab();
      const state = await command("read");
      if (lastTop >= 0 && state.top <= lastTop + 1) throw new Error("页面未能继续向下滚动，本次截图不完整，未自动发送模型。");
      const dataUrl = await operation(chromeApi.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 88 }), signal, "截取页面图片", timeoutMs);
      await assertTab();
      await onImage(dataUrl, state, count);
      count++;
      onProgress?.(count, state);
      if (state.top + state.height >= state.total - 2) return count;
      lastTop = state.top;
      await command("scroll", Math.min(state.top + state.height * 0.85, state.total - state.height));
    }
    throw new Error(`页面超过 ${maxImages} 张截图上限，已保留部分截图但未自动发送模型。请展开更精简的岗位详情后重试。`);
  } finally {
    // Never let a closed/navigated tab hide the original capture failure.
    await command("restore").catch(() => {});
  }
}
