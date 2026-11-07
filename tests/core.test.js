import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROVIDERS, SYSTEM_PROMPT, endpointFor, buildRequest, parseCompletion, generateGreeting,
} from "../extension/core.js";

const screenshot = { dataUrl: "data:image/png;base64,aGVsbG8=" };
const input = (provider = "qwen") => ({
  provider, ...PROVIDERS[provider], apiKey: "sk-unit-test-secret",
  experience: "# 个人事实\n参与知识库产品需求整理，交付需求文档。", style: "# 写作偏好\n正式自然，不写未确认的能力。",
  images: [screenshot],
});
const completion = (result, finish_reason = "stop") => ({
  choices: [{ finish_reason, message: { content: JSON.stringify(result) } }],
});

test("three providers use image content parts and preserve full Markdown", () => {
  for (const provider of Object.keys(PROVIDERS)) {
    const source = input(provider);
    const request = buildRequest(source);
    assert.equal(request.model, source.model);
    assert.equal(request.messages[0].content, SYSTEM_PROMPT);
    const parts = request.messages[1].content;
    assert.equal(parts[1].type, "image_url");
    assert.equal(parts[1].image_url.url, screenshot.dataUrl);
    const materials = JSON.parse(parts[0].text.slice(parts[0].text.indexOf("\n") + 1));
    assert.equal(materials.personal_experience, source.experience);
    assert.equal(materials.greeting_style, source.style);
    assert.ok(!JSON.stringify(request).includes(source.apiKey));
  }
});

test("vision-model parameters are isolated by provider", () => {
  assert.deepEqual(buildRequest(input("deepseek")).thinking, { type: "disabled" });
  assert.equal(buildRequest(input("qwen")).enable_thinking, false);
  assert.equal(buildRequest(input("kimi")).reasoning_effort, "low");
  assert.equal(buildRequest({ ...input("kimi"), model: "some-other-vision-model" }).reasoning_effort, undefined);
});

test("endpoint normalization supports a base or complete completion URL", () => {
  assert.equal(endpointFor("https://example.com/v1/"), "https://example.com/v1/chat/completions");
  assert.equal(endpointFor("https://example.com/v1/chat/completions"), "https://example.com/v1/chat/completions");
  for (const url of ["http://example.com", "https://user:password@example.com", "https://example.com?key=secret", "file:///x"]) {
    assert.throws(() => endpointFor(url));
  }
});

test("missing materials and malformed images stop before network access", async () => {
  for (const patch of [{ apiKey: "" }, { experience: "" }, { style: "" }, { images: [] }, { images: [{ dataUrl: "https://example.com/screenshot" }] }]) {
    let requests = 0;
    await assert.rejects(generateGreeting({ ...input(), ...patch }, { fetchImpl: async () => { requests++; } }));
    assert.equal(requests, 0);
  }
});

test("generation sends only to configured endpoint and keeps notes outside greeting", async () => {
  let requests = 0;
  const abort = new AbortController();
  const result = await generateGreeting(input(), {
    signal: abort.signal,
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer sk-unit-test-secret");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.signal, abort.signal);
      assert.equal(JSON.parse(options.body).messages[1].content.length, 2);
      return new Response(JSON.stringify(completion({ greeting: "您好，我有需求整理经验，期待进一步交流。", notes: ["到岗条件未提供。"] })));
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.greeting, "您好，我有需求整理经验，期待进一步交流。");
  assert.ok(!result.greeting.includes(result.notes[0]));
});

test("API errors redact keys and do not trigger automatic retries", async () => {
  let requests = 0;
  await assert.rejects(generateGreeting(input(), { fetchImpl: async () => {
    requests++;
    return new Response(JSON.stringify({ error: { message: "bad key sk-unit-test-secret" } }), { status: 401 });
  } }), error => error.message.includes("401") && !error.message.includes("sk-unit-test-secret"));
  assert.equal(requests, 1);
});

test("HTML error pages, empty completions and truncated text are not copyable successes", async () => {
  await assert.rejects(generateGreeting(input(), { fetchImpl: async () => new Response("<html>not an API</html>", { status: 404 }) }), /JSON/);
  assert.throws(() => parseCompletion({ choices: [{ message: { content: "" } }] }), /空正文/);
  assert.throws(() => parseCompletion(completion({ greeting: "partial", notes: [] }, "length")), /截断/);
  assert.throws(() => parseCompletion(completion({ greeting: "not valid", notes: "invalid" })), /字段/);
});

test("valid fenced JSON is accepted; unreadable screenshot can request clarification without a greeting", () => {
  const fenced = { choices: [{ message: { content: '```json\n{"greeting":"您好。","notes":[]}\n```' } }] };
  assert.equal(parseCompletion(fenced).greeting, "您好。");
  assert.deepEqual(parseCompletion(completion({ greeting: "", notes: ["截图没有完整职责，请补充下半部分。"] })), {
    greeting: "", notes: ["截图没有完整职责，请补充下半部分。"],
  });
});

test("cancellation is forwarded and abort is not swallowed", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateGreeting(input(), { signal: controller.signal, fetchImpl: async (_url, options) => {
    options.signal.throwIfAborted();
  } }), error => error.name === "AbortError");
});

test("extension asks for provider access on demand and has no persistent content script", () => {
  const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*", "<all_urls>"]);
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(!manifest.permissions.includes("cookies"));
});
