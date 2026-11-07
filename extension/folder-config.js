export async function configFolder(handle) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("greeting-folder", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("settings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("settings", handle ? "readwrite" : "readonly");
      const store = tx.objectStore("settings");
      const request = handle ? store.put(handle, "folder") : store.get("folder");
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function readText(handle, limit) {
  const file = await handle.getFile();
  if (file.size > limit * 4) throw new Error(`文件过大：${file.name}`);
  const value = (await file.text()).replace(/^\uFEFF/, "").trim();
  if (value.length > limit || value.includes("\0")) throw new Error(`文件格式不符：${file.name}`);
  return value;
}

async function readFolderFile(root, folder, match, limit, label) {
  const dir = await root.getDirectoryHandle(folder).catch(error => {
    if (error.name === "NotFoundError") return null;
    throw error;
  });
  if (!dir) return "";
  const files = [];
  for await (const entry of dir.values()) {
    if (entry.kind === "file" && match.test(entry.name)) files.push(entry);
  }
  if (files.length > 1) throw new Error(`请在 ${folder} 中只保留一份${label}文件。`);
  return files.length ? readText(files[0], limit) : "";
}

export async function readFolderConfig(root, mdLimit) {
  const [experience, style, baseUrl, apiKey] = await Promise.all([
    readFolderFile(root, "experience", /\.md$/i, mdLimit, "经历"),
    readFolderFile(root, "style", /\.md$/i, mdLimit, "风格"),
    readFolderFile(root, "key", /^(?:key)?urlbase(?:\.txt)?$/i, 2048, "Base URL"),
    readFolderFile(root, "key", /^(?:key)?apikey(?:\.txt)?$/i, 4096, "API Key"),
  ]);
  const missing = [];
  if (!experience) missing.push("experience 下的个人经历 Markdown");
  if (!style) missing.push("style 下的风格 Markdown");
  if (!apiKey) missing.push("key/keyapikey.txt");
  if (!baseUrl) missing.push("key/keyurlbase.txt");
  if (missing.length) throw new Error(`缺少或为空：${missing.join("、")}`);
  return { experience, style, baseUrl, apiKey };
}
