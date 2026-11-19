// Что показать менеджеру по ответу API. Чистая функция: без DOM, её проверяет тест.
// Любой ответ, кроме ready, ведёт к ручному разбору с пустым черновиком.

const TOPIC_LABELS = { delivery: "Доставка", pricing: "Цена", other: "Другое" };

export const PENDING_VIEW = { message: "Разбираем заявку…", topic: "", draft: "" };

export function toView(httpStatus, body) {
  if (httpStatus === 200 && body?.status === "ready") {
    return { message: "", topic: TOPIC_LABELS[body.topic] ?? body.topic, draft: body.draft };
  }
  if (httpStatus === 400 && body?.status === "invalid_input") {
    return { message: "Введите текст заявки.", topic: "", draft: "" };
  }
  return {
    message: "AI не смог разобрать заявку. Определите тему и напишите ответ вручную.",
    topic: "",
    draft: "",
  };
}
