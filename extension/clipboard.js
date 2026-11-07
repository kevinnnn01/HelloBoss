chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "offscreen-copy" || sender.id !== chrome.runtime.id || sender.tab) return;
  const field = document.getElementById("clipboard");
  try {
    field.value = message.text;
    field.select();
    respond({ copied: document.execCommand("copy") });
  } catch {
    respond({ copied: false });
  } finally {
    field.value = "";
  }
});
