import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createApp, MODEL_TIMEOUT_MS } from "../server.mjs";
import { toView } from "../view.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

async function start(options = {}) {
  const server = createApp({ log: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

function stop(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

async function triage(baseUrl, rawBody) {
  const reply = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  return { status: reply.status, body: await reply.json() };
}

const asJson = (text) => JSON.stringify({ text });

describe("POST /api/triage с выданным имитатором", () => {
  let app;
  before(async () => {
    app = await start();
  });
  after(() => stop(app.server));

  test("корректный ответ модели → ready с темой и черновиком", async () => {
    const delivery = await triage(app.url, asJson("Когда будет доставка заказа?"));
    assert.equal(delivery.status, 200);
    assert.deepEqual(delivery.body, {
      status: "ready",
      topic: "delivery",
      draft: "Спасибо за обращение. Уточним детали заявки.",
    });

    const pricing = await triage(app.url, asJson("Какая цена у тарифа?"));
    assert.equal(pricing.body.topic, "pricing");
  });

  const invalidBodies = {
    "пустое тело": "",
    "битый JSON": "{text:",
    "null вместо объекта": "null",
    "массив вместо объекта": "[]",
    "нет поля text": "{}",
    "text — число": JSON.stringify({ text: 42 }),
    "text — null": JSON.stringify({ text: null }),
    "text — пустая строка": asJson(""),
    "text — одни пробелы": asJson("  \n\t "),
  };
  for (const [name, rawBody] of Object.entries(invalidBodies)) {
    test(`некорректный ввод (${name}) → 400 invalid_input`, async () => {
      const reply = await triage(app.url, rawBody);
      assert.equal(reply.status, 400);
      assert.deepEqual(reply.body, { status: "invalid_input" });
    });
  }

  for (const tag of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    test(`сбой модели ${tag} → 200 manual_review без темы и черновика`, async () => {
      const reply = await triage(app.url, asJson(`Где мой заказ? ${tag}`));
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, MANUAL_REVIEW);
    });
  }

  test("таймаут модели укладывается в лимит, а не ждёт 1200 мс имитатора", async () => {
    const startedAt = performance.now();
    const reply = await triage(app.url, asJson("Заявка [timeout]"));
    const elapsed = performance.now() - startedAt;
    assert.deepEqual(reply.body, MANUAL_REVIEW);
    assert.ok(elapsed < MODEL_TIMEOUT_MS + 200, `ответ через ${Math.round(elapsed)} мс`);
  });
});

describe("POST /api/triage с подменённой моделью", () => {
  // Лимит теста: без защиты сервер ждал бы вечно, и прогон должен упасть, а не повиснуть.
  test("модель игнорирует отмену и не отвечает → manual_review по таймауту", { timeout: 2_000 }, async () => {
    const app = await start({ classify: () => new Promise(() => {}), timeoutMs: 50 });
    try {
      const reply = await triage(app.url, asJson("Заявка"));
      assert.deepEqual(reply.body, MANUAL_REVIEW);
    } finally {
      await stop(app.server);
    }
  });

  test("черновик не строка → manual_review", async () => {
    const classify = async () => JSON.stringify({ topic: "other", draft: 123 });
    const app = await start({ classify });
    try {
      const reply = await triage(app.url, asJson("Заявка"));
      assert.deepEqual(reply.body, MANUAL_REVIEW);
    } finally {
      await stop(app.server);
    }
  });

  test("сбой пишется в лог с причиной, но без текста заявки", async () => {
    const events = [];
    const app = await start({ log: (event, details) => events.push({ event, ...details }) });
    try {
      await triage(app.url, asJson("Телефон +7 900 000-00-00 [bad-topic]"));
      assert.deepEqual(events, [{ event: "manual_review", reason: "model_invalid_output" }]);
    } finally {
      await stop(app.server);
    }
  });
});

describe("экран менеджера (toView)", () => {
  const previousDraft = toView(200, { status: "ready", topic: "pricing", draft: "Старый черновик" });

  test("ready показывает тему и черновик", () => {
    assert.deepEqual(previousDraft, { message: "", topic: "Цена", draft: "Старый черновик" });
  });

  const failures = {
    manual_review: [200, MANUAL_REVIEW],
    "ошибка сервера": [500, { status: "server_error" }],
    "сеть или таймаут браузера": [0, null],
  };
  for (const [name, [httpStatus, body]] of Object.entries(failures)) {
    test(`${name} → сообщение о ручном разборе и пустой черновик`, () => {
      const view = toView(httpStatus, body);
      assert.match(view.message, /вручную/);
      assert.equal(view.topic, "");
      assert.equal(view.draft, "");
    });
  }

  test("пустой ввод → просьба ввести текст", () => {
    assert.deepEqual(toView(400, { status: "invalid_input" }), {
      message: "Введите текст заявки.",
      topic: "",
      draft: "",
    });
  });
});
