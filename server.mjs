import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const html = await readFile(new URL("./index.html", import.meta.url));
const viewJs = await readFile(new URL("./view.mjs", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Текст заявки или null, если ввод не подходит: битый JSON, не объект,
// нет поля text, не строка или строка из одних пробелов.
export function parseInput(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  if (typeof body.text !== "string" || body.text.trim() === "") return null;
  return body.text;
}

// Ответ модели — недоверенные данные. HTTP 200 от провайдера не значит,
// что результат годится: проверяем JSON, тему из списка и непустой черновик.
export function parseModelOutput(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  if (!TOPICS.has(data.topic)) return null;
  if (typeof data.draft !== "string" || data.draft.trim() === "") return null;
  return { topic: data.topic, draft: data.draft.trim() };
}

// Ждём модель не дольше timeoutMs. Сигнал отменяет запрос к модели, а гонка
// с таймером защищает, даже если модель сигнал игнорирует.
async function callModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`model timeout after ${timeoutMs} ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Текст заявки в лог не пишем: в нём могут быть персональные данные клиента.
function defaultLog(event, details) {
  console.warn(JSON.stringify({ event, ...details }));
}

export function createApp({ classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS, log = defaultLog } = {}) {
  async function handleTriage(request, response) {
    const text = parseInput(await readBody(request));
    if (text === null) return json(response, 400, { status: "invalid_input" });

    let raw;
    try {
      raw = await callModel(classify, text, timeoutMs);
    } catch (error) {
      log("manual_review", { reason: "model_failed", error: String(error?.message ?? error) });
      return json(response, 200, MANUAL_REVIEW);
    }

    const result = parseModelOutput(raw);
    if (result === null) {
      log("manual_review", { reason: "model_invalid_output" });
      return json(response, 200, MANUAL_REVIEW);
    }
    return json(response, 200, { status: "ready", ...result });
  }

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && request.url === "/view.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(viewJs);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
