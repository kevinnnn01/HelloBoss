chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  // A disabled side panel can be reopened with the toolbar action after reload.
});

let clipboardQueue = Promise.resolve();

async function writeClipboard(text) {
  const url = chrome.runtime.getURL("clipboard.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url],
  });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: "clipboard.html",
      reasons: ["CLIPBOARD"],
      justification: "Copy generated greeting text when the side panel does not have focus.",
    });
  }
  try {
    return await chrome.runtime.sendMessage({ type: "offscreen-copy", text });
  } finally {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "copy-greeting" || sender.url !== chrome.runtime.getURL("panel.html")) return;
  if (typeof message.text !== "string" || !message.text.trim() || message.text.length > 20000) {
    respond({ copied: false });
    return;
  }
  clipboardQueue = clipboardQueue
    .then(() => writeClipboard(message.text))
    .then(result => respond({ copied: result?.copied === true }), () => respond({ copied: false }));
  return true;
});
