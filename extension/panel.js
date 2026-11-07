import {
  PROVIDERS, DEFAULT_STYLE, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES,
  MAX_MD_CHARS, endpointFor, validateInputs, generateGreeting, redact,
} from "./core.js";
import { captureScrollingPage } from "./scroll-capture.js";
import { GoFullPageCompositor } from "./vendor/gofullpage/capture-core.js";
import { configFolder, readFolderConfig } from "./folder-config.js";

const $ = id => document.getElementById(id);
const isExtension = Boolean(globalThis.chrome?.storage?.local);
let provider = "qwen";
let configs = {};
let keys = {};
let images = [];
let controller = null;
let busy = false;
let imagePending = 0;
let stale = false;
let folderHandle;

function status(message, kind = "") {
  $("activity").hidden = false;
  $("activity-status").textContent = message;
  $("activity-status").className = `status ${kind}`;
}

function updateOutput() {
  const text = $("greeting").value;
  $("char-count").textContent = `${Array.from(text.replace(/\s/g, "")).length} 字符`;
  $("copy").disabled = !text.trim() || stale || busy;
  $("copy").textContent = "复制正文";
}

function markStale() {
  if ($("greeting").value.trim()) {
    stale = true;
    $("result-source").textContent = "输入已变化，请重新生成。";
  }
  updateOutput();
}

function updateDestination() {
  try {
    const url = new URL(endpointFor($("base-url").value));
    $("destination").textContent = `生成招呼语时，截图、经历及风格将发送至 ${url.host}。启用自动生成后，截屏完成即调用模型并复制正文。`;
  } catch {
    $("destination").textContent = "请在模型连接中填写有效的 API 地址。";
  }
}

function rememberCurrentConfig() {
  configs[provider] = { model: $("model").value.trim(), baseUrl: $("base-url").value.trim() };
  keys[provider] = $("api-key").value.trim();
}

function showProvider() {
  const preset = PROVIDERS[provider];
  const saved = configs[provider] || preset;
  $("provider").value = provider;
  $("model").value = saved.model;
  $("base-url").value = saved.baseUrl;
  $("api-key").value = keys[provider] || "";
  $("provider-label").textContent = preset.label.split(" · ")[0];
  $("provider-hint").textContent = preset.hint;
  updateDestination();
}

async function saveSettings(showMessage = true) {
  if (!isExtension) {
    if (showMessage) status("这是界面预览，请在 Chrome 扩展管理页加载 extension 文件夹后保存。", "error");
    return;
  }
  rememberCurrentConfig();
  await chrome.storage.local.set({
    settings: { provider, configs, experience: $("experience").value, style: $("style").value },
  });
  await chrome.storage.session.set({ keys });
  if (showMessage) $("save-status").textContent = "已保存到本机";
}

async function hydrate() {
  $("style").value = DEFAULT_STYLE;
  if (isExtension) {
    $("version").textContent = `v${chrome.runtime.getManifest().version}`;
    // Restrict stored materials to extension pages, even if content scripts are added later.
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const [local, session] = await Promise.all([
      chrome.storage.local.get("settings"), chrome.storage.session.get("keys"),
    ]);
    const saved = local.settings;
    if (saved) {
      provider = PROVIDERS[saved.provider] ? saved.provider : "qwen";
      configs = saved.configs || {};
      $("experience").value = saved.experience || "";
      $("style").value = saved.style ?? DEFAULT_STYLE;
      if (saved.experience) $("materials").open = false;
    }
    keys = session.keys || {};
  } else {
    $("capture").disabled = true;
    status("界面预览：请在 Chrome 扩展管理页加载 extension 文件夹，以使用截图和 API。", "error");
  }
  showProvider();
  if (isExtension && globalThis.indexedDB) {
    setBusy(true, "capture");
    try {
      folderHandle = await configFolder();
      if (folderHandle && await folderHandle.queryPermission({ mode: "read" }) === "granted") {
        await applyFolderConfig(folderHandle);
      } else if (folderHandle) {
        $("folder-status").textContent = "点击重新读取，恢复目录访问。";
      }
    } catch (error) {
      $("folder-status").textContent = error.message;
    } finally {
      setBusy(false);
    }
  }
}

async function applyFolderConfig(handle) {
  const config = await readFolderConfig(handle, MAX_MD_CHARS);
  const origin = new URL(endpointFor(config.baseUrl)).origin;
  const detected = Object.keys(PROVIDERS).find(id => new URL(PROVIDERS[id].baseUrl).origin === origin);
  if (detected && detected !== provider) {
    rememberCurrentConfig();
    provider = detected;
    showProvider();
  }
  $("base-url").value = config.baseUrl;
  $("api-key").value = config.apiKey;
  $("experience").value = config.experience;
  $("style").value = config.style;
  rememberCurrentConfig();
  updateDestination();
  $("folder-status").textContent = `已从 ${handle.name} 载入经历、风格、Base URL 和 API Key。`;
  $("config-status").textContent = "目录配置已载入";
  markStale();
}

async function loadFolder(reselect) {
  if (!isExtension || busy) return;
  setBusy(true, "capture");
  try {
    const handle = reselect || !folderHandle
      ? await window.showDirectoryPicker({ id: "boss-config", startIn: "desktop", mode: "read" })
      : folderHandle;
    if (handle === folderHandle && await handle.requestPermission({ mode: "read" }) !== "granted") {
      throw new Error("需要允许读取目录才能加载配置。");
    }
    await applyFolderConfig(handle);
    folderHandle = handle;
    await configFolder(handle);
  } catch (error) {
    if (error.name !== "AbortError") $("folder-status").textContent = `读取目录失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

function renderImages() {
  $("image-count").textContent = `${images.length} / ${MAX_IMAGES}`;
  const cards = images.map((item, index) => {
    const card = document.createElement("div");
    card.className = "image-item";
    const img = document.createElement("img");
    img.src = item.dataUrl;
    img.alt = `岗位截图 ${index + 1}：${item.name}`;
    const caption = document.createElement("div");
    caption.className = "image-caption";
    const name = document.createElement("span");
    name.textContent = `${index + 1}. ${item.name}`;
    name.title = item.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-image";
    remove.textContent = "移除";
    remove.setAttribute("aria-label", `移除截图 ${index + 1}`);
    remove.addEventListener("click", () => {
      images.splice(index, 1);
      renderImages();
      markStale();
    });
    caption.append(name, remove);
    card.append(img, caption);
    return card;
  });
  $("image-list").replaceChildren(...cards);
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择文件。"));
    reader.readAsDataURL(file);
  });
}

async function appendImage(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("仅支持 PNG、JPEG 和 WebP 图片。");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("每张图片最多 6 MB，请分段截取或压缩。");
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("无法识别图片，请更换有效的截图。"); });
  const tooLarge = bitmap.width > 8192 || bitmap.height > 8192;
  bitmap.close();
  if (tooLarge) throw new Error("截图过长或过宽（超过 8192 像素），请分段截取。");
  const dataUrl = await readDataUrl(file);
  // Recheck after asynchronous decoding to handle simultaneous paste/capture operations.
  if (images.length >= MAX_IMAGES) throw new Error(`同一岗位最多 ${MAX_IMAGES} 张图片，请先移除旧截图。`);
  if (images.reduce((sum, image) => sum + image.size, 0) + file.size > MAX_TOTAL_BYTES) {
    throw new Error("图片总大小超过 12 MB，请减少或压缩图片。");
  }
  images.push({ dataUrl, size: file.size, name: file.name || "粘贴截图" });
  renderImages();
  markStale();
}

async function addFiles(files) {
  imagePending++;
  $("generate").disabled = true;
  try {
    for (const file of files) await appendImage(file);
    status(`已添加截图，共 ${images.length} 张。请确认它们属于同一个岗位。`);
  } catch (error) { status(error.message, "error"); }
  finally { imagePending--; $("generate").disabled = busy || imagePending > 0; }
}

function collectInput() {
  return {
    provider, model: $("model").value, baseUrl: $("base-url").value, apiKey: $("api-key").value,
    experience: $("experience").value, style: $("style").value, images: images.map(image => ({ ...image })),
  };
}

async function cropCapture(dataUrl, state) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const scaleX = bitmap.width / state.viewportWidth;
    const scaleY = bitmap.height / state.viewportHeight;
    const x = Math.round(state.rect.left * scaleX);
    const y = Math.round(state.rect.top * scaleY);
    const width = Math.min(bitmap.width - x, Math.round(state.rect.width * scaleX));
    const height = Math.min(bitmap.height - y, Math.round(state.rect.height * scaleY));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
  } finally { bitmap.close(); }
}

async function capture() {
  if (!isExtension) return status("请加载为 Chrome 扩展后截屏，或上传系统截图。", "error");
  if (busy || imagePending) return;
  const input = collectInput();
  const mode = $("capture-mode").value;
  const autoGenerate = $("auto-generate").checked;
  let generationIssue = "";
  if (autoGenerate) {
    try { validateInputs(input, { requireImages: false }); }
    catch (error) { generationIssue = error.message; }
  }
  setBusy(true, "capture");
  status("已开始截屏，正在检查当前网页与权限…", "busy");
  controller = new AbortController();
  $("cancel-top").disabled = false;
  let complete = false;
  let permissionGranted = false;
  const compositor = mode === "gofullpage" ? new GoFullPageCompositor() : null;
  try {
    // API access is requested during the click, but is never a prerequisite for capture.
    if (autoGenerate && !generationIssue) {
      const origin = `${new URL(endpointFor(input.baseUrl)).origin}/*`;
      permissionGranted = await chrome.permissions.request({ origins: [origin] });
      if (!permissionGranted) generationIssue = "尚未允许访问模型接口，可稍后点击“生成招呼语”授权。";
    }
    controller.signal.throwIfAborted();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("未找到当前标签页，请切换到目标网页后重试。");
    if (tab.url && !/^https?:/.test(tab.url)) throw new Error("浏览器设置页及扩展页不支持截屏，请切换到目标岗位网页。");
    if (mode !== "visible" && (!chrome.scripting || !await chrome.permissions.contains({ permissions: ["scripting"] }))) {
      throw new Error(`当前加载版本 v${chrome.runtime.getManifest().version} 未获得滚动权限。请重新加载新版并按 Chrome 提示启用，或先选择“仅截当前可见区”。`);
    }
    controller.signal.throwIfAborted();
    images = [];
    renderImages();
    markStale();
    $("capture-source").textContent = `本次来源：${tab.title || "当前标签页"}；正在截图。`;
    if (mode === "visible") {
      const { captureVisiblePage } = await import("./scroll-capture.js");
      await captureVisiblePage({ chromeApi: chrome, tab, signal: controller.signal, onImage: async dataUrl => {
        const blob = await (await fetch(dataUrl)).blob();
        await appendImage(new File([blob], "当前可见区域.jpg", { type: "image/jpeg" }));
      } });
    } else {
      status("正在识别滚动区并回到顶部…", "busy");
      await captureScrollingPage({
        chromeApi: chrome, tab, mode, maxImages: MAX_IMAGES, signal: controller.signal,
        onImage: async (dataUrl, state, index) => {
          const blob = await cropCapture(dataUrl, state);
          controller.signal.throwIfAborted();
          if (compositor) {
            const bitmap = await createImageBitmap(blob);
            try { compositor.draw(bitmap, state); } finally { bitmap.close(); }
          } else {
            await appendImage(new File([blob], `自动截图-${index + 1}.jpg`, { type: "image/jpeg" }));
          }
        },
        onProgress: (count, state) => status(`正在截取${state.label || "网页"}：已完成 ${count} 帧，进度 ${Math.min(100, Math.round((state.captureProgress ?? (state.top + state.height) / state.total) * 100))}%。`, "busy"),
      });
      if (compositor) {
        status("GoFullPage：已完成采集，正在拼接并按阅读尺寸分片…", "busy");
        const blobs = await compositor.toBlobs();
        for (const [index, blob] of blobs.entries()) {
          controller.signal.throwIfAborted();
          await appendImage(new File([blob], `GoFullPage-${index + 1}.jpg`, { type: "image/jpeg" }));
        }
      }
    }
    controller.signal.throwIfAborted();
    complete = true;
    $("capture-source").textContent = `本次来源：${tab.title || "当前标签页"} · 已完成 ${images.length} 张截图。`;
    status(generationIssue ? `截图已完成。自动生成暂未执行：${generationIssue}` : `截图已完成，共 ${images.length} 张，可在下方查看。`, generationIssue ? "error" : "");
  } catch (error) {
    let message = error.message;
    if (/Cannot access|not allowed|permission|host permission|activeTab|all_urls/i.test(message)) {
      message = `网页访问或截图授权不可用。请点击“启用截图权限”，在 Chrome 提示中允许后重试。原始错误：${redact(message, input.apiKey.trim())}`;
    }
    status(error.name === "AbortError" ? "已取消截屏，未自动调用模型。" : `截屏未完成：${message}`, "error");
    $("capture-source").textContent = `本次未完成，已保留 ${images.length} 张图片，请先检查预览。`;
  } finally {
    compositor?.dispose();
    controller = null;
    setBusy(false);
  }
  if (complete && autoGenerate && !generationIssue) await generate({ permissionGranted, autoCopy: true });
}

async function importMarkdown(file, target) {
  if (!file) return;
  if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error("请导入 .md、.markdown 或 .txt 文件。");
  if (file.size > 400000) throw new Error("文件过大，请精简为 100,000 字符以内的 Markdown。");
  const text = (await file.text()).replace(/^\uFEFF/, "");
  if (text.length > MAX_MD_CHARS) throw new Error("每份 Markdown 最多 100,000 个字符。");
  if (text.includes("\0")) throw new Error("文件不是有效的文本 Markdown，请检查编码。");
  $(target).value = text;
  $("save-status").textContent = "资料有修改，尚未保存";
  markStale();
  status(`已导入${target === "experience" ? "个人经历" : "打招呼风格"}：${file.name}`);
}

function setBusy(value, stage = "generate") {
  busy = value;
  $("inputs").disabled = value;
  $("quick-actions").disabled = value;
  $("greeting").readOnly = value;
  $("generate").disabled = value || imagePending > 0;
  $("generate").textContent = value ? (stage === "capture" ? "正在截屏…" : "正在生成…") : "生成招呼语 ↗";
  updateCaptureLabel();
  $("cancel-top").hidden = !value;
  $("cancel-top").disabled = value;
  updateOutput();
}

function updateCaptureLabel() {
  $("capture").textContent = busy ? "处理中…" : $("auto-generate").checked ? "一键截屏并复制招呼语" : "仅截屏";
}

async function generate({ permissionGranted = false, autoCopy = false } = {}) {
  if (busy || imagePending) return;
  if (!isExtension) return status("请先在 Chrome 扩展管理页加载 extension 文件夹，以调用模型 API。", "error");
  const input = collectInput();
  try { validateInputs(input); }
  catch (error) { status(error.message, "error"); return; }

  setBusy(true);
  let timeout;
  let timedOut = false;
  try {
    // Called before any unrelated await so Chrome retains the user gesture.
    const origin = `${new URL(endpointFor(input.baseUrl)).origin}/*`;
    const allowed = permissionGranted
      ? await chrome.permissions.contains({ origins: [origin] })
      : await chrome.permissions.request({ origins: [origin] });
    if (!allowed) throw new Error("尚未允许访问模型接口。点击生成并允许当前接口地址后即可调用。");
    await saveSettings(false);
    $("save-status").textContent = "已保存到本机";
    stale = true;
    $("result-source").textContent = "正在生成本次截图对应的正文…";
    controller = new AbortController();
    $("cancel-top").disabled = false;
    timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 120000);
    status("正在识别岗位并匹配经历，请稍候。可取消本次请求。", "busy");
    const result = await generateGreeting(input, { signal: controller.signal });
    controller.signal.throwIfAborted();
    clearTimeout(timeout);
    $("cancel-top").disabled = true;
    $("greeting").value = result.greeting;
    const notes = result.notes.map(note => {
      const p = document.createElement("p");
      p.textContent = note;
      return p;
    });
    $("notes").replaceChildren(...notes);
    $("notes").hidden = !notes.length;
    stale = false;
    $("result-source").textContent = `${PROVIDERS[provider].label.split(" · ")[0]} · ${input.images.length} 张截图 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    if (autoCopy && result.greeting.trim()) {
      await copyGreeting();
    } else {
      status(result.greeting ? "已生成，可直接编辑。复制后请在 BOSS 中核对并发送。" : "暂未生成正文，请查看下方补充提示。", result.greeting ? "" : "error");
    }
  } catch (error) {
    if (error.name === "AbortError") status(timedOut ? "请求超过 120 秒，已停止等待。请稍后重试或更换模型。" : "已取消等待；如果请求已发出，供应商仍可能计费。", "error");
    else if (error instanceof TypeError) status("无法连接接口，请检查网络、Base URL 和访问权限。", "error");
    else status(redact(error.message, input.apiKey.trim()), "error");
    if (stale) $("result-source").textContent = "本次未完成，请重新生成。";
  } finally {
    clearTimeout(timeout);
    controller = null;
    setBusy(false);
  }
}

$("provider").addEventListener("change", () => {
  rememberCurrentConfig();
  provider = $("provider").value;
  showProvider();
  markStale();
});
for (const id of ["experience", "style", "model", "base-url", "api-key"]) {
  $(id).addEventListener("input", () => {
    $("save-status").textContent = "配置有修改，尚未保存";
    markStale();
    if (id === "base-url") updateDestination();
  });
}
$("greeting").addEventListener("input", updateOutput);
$("save").addEventListener("click", () => saveSettings().catch(() => status("本机保存失败，请检查扩展权限或存储空间。", "error")));
$("capture").addEventListener("click", capture);
$("choose-folder").addEventListener("click", () => loadFolder(true));
$("reload-folder").addEventListener("click", () => loadFolder(false));
$("auto-generate").addEventListener("change", updateCaptureLabel);
$("authorize-capture").addEventListener("click", async () => {
  if (!isExtension || busy) return;
  // Must be the first asynchronous operation in this explicit user gesture.
  // A site-only grant does not satisfy captureVisibleTab without activeTab.
  try {
    const request = chrome.permissions.request({ origins: ["<all_urls>"] });
    setBusy(true, "capture");
    status("等待 Chrome 截图权限授权…", "busy");
    const allowed = await request;
    status(allowed
      ? "截图权限已启用。请回到目标岗位页，点击截屏按钮。"
      : "未授予截图权限。可在目标岗位页点击工具栏插件图标尝试临时授权，或上传截图。", allowed ? "" : "error");
  } catch (error) {
    status(`启用截图权限失败（v${chrome.runtime.getManifest().version}）：${redact(error.message, $("api-key").value.trim())}。请确认已重新加载 0.4.1 或更新版本。`, "error");
  } finally { setBusy(false); }
});
$("upload").addEventListener("click", () => $("image-file").click());
$("image-file").addEventListener("change", event => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) addFiles(files);
});
document.addEventListener("paste", event => {
  if (busy) return;
  const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter(Boolean);
  if (files.length) { event.preventDefault(); addFiles(files); }
});
for (const name of ["dragover", "dragleave", "drop"]) {
  $("drop-zone").addEventListener(name, event => {
    event.preventDefault();
    $("drop-zone").classList.toggle("dragover", name === "dragover");
    if (name === "drop" && !busy) addFiles(Array.from(event.dataTransfer.files));
  });
}
for (const target of ["experience", "style"]) {
  $(`import-${target}`).addEventListener("click", () => $(`${target}-file`).click());
  $(`${target}-file`).addEventListener("change", event => {
    const file = event.target.files[0];
    event.target.value = "";
    importMarkdown(file, target).catch(error => status(error.message, "error"));
  });
}
$("generate").addEventListener("click", generate);
$("cancel-top").addEventListener("click", () => controller?.abort());
async function copyGreeting() {
  const text = $("greeting").value.trim();
  if (stale || !text) return;
  try {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const result = await chrome.runtime.sendMessage({ type: "copy-greeting", text });
      if (!result?.copied) throw new Error("Clipboard unavailable");
    }
    $("copy").textContent = "已复制 ✓";
    status("正文已复制，可到 BOSS 聊天框粘贴发送。");
  } catch {
    $("greeting").readOnly = false;
    $("greeting").focus();
    $("greeting").select();
    status("正文已保留。剪贴板写入失败，请按 Ctrl + C 或点击“复制正文”。", "error");
  }
}
$("copy").addEventListener("click", copyGreeting);
hydrate().catch(() => status("加载本机配置失败，请重新加载插件后重试。", "error"));
