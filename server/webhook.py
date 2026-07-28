"""Приёмник ответов мини-аппа Умскул.

Мини-апп, открытый по прямой ссылке (t.me/<bot>/<app>), не может использовать
sendData() — ответы уходят обычным POST на этот сервис. Здесь они проверяются
по подписи Telegram initData и пересылаются дальше: в вебхук бот-конструктора
(bot-marketing) или в retailCRM.

Зависимостей нет, только стандартная библиотека:

    BOT_TOKEN=123:ABC \
    FORWARD_URL=https://<вебхук бот-конструктора> \
    ALLOWED_ORIGIN=https://<user>.github.io \
    python server/webhook.py

Переменные окружения:
    BOT_TOKEN           токен бота из BotFather — нужен для проверки подписи
    FORWARD_URL         куда переслать нормализованный лид (POST JSON)
    FORWARD_HEADERS     JSON с доп. заголовками для FORWARD_URL (например, ключ)
    ALLOWED_ORIGIN      Origin мини-аппа для CORS ('*' по умолчанию)
    INIT_DATA_MAX_AGE   срок годности initData в секундах (по умолчанию 86400)
    REQUIRE_SIGNATURE   '0' отключает проверку подписи (только для локальных тестов)
    PORT                порт (по умолчанию 8080)
"""

import hashlib
import hmac
import json
import logging
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl

MAX_BODY = 64 * 1024

log = logging.getLogger("umskul.webhook")


def verify_init_data(init_data: str, bot_token: str, max_age: int = 86400) -> dict:
    """Проверяет подпись Telegram WebApp initData и возвращает её поля.

    Алгоритм: secret = HMAC_SHA256("WebAppData", bot_token),
    затем HMAC_SHA256(secret, "key=value\\n..." по отсортированным ключам)
    сравнивается с полем hash.
    """
    fields = dict(parse_qsl(init_data, keep_blank_values=True))
    received = fields.pop("hash", None)
    if not received:
        raise ValueError("initData без hash")

    check_string = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    calculated = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calculated, received):
        raise ValueError("подпись initData не совпала")

    try:
        auth_date = int(fields.get("auth_date", "0"))
    except ValueError:
        raise ValueError("некорректный auth_date")
    if max_age and (time.time() - auth_date) > max_age:
        raise ValueError("initData просрочен")

    if "user" in fields:
        fields["user"] = json.loads(fields["user"])
    return fields


def build_lead(envelope: dict, tg_fields: dict) -> dict:
    """Собирает плоский лид: ответы анкеты + подтверждённый пользователь Telegram."""
    answers = envelope.get("data") or {}
    user = tg_fields.get("user") or {}
    subjects = answers.get("subjects") or []
    unit = "баллы" if answers.get("goal_unit") == "score" else "оценка"

    return {
        "telegram_id": user.get("id"),
        "telegram_username": user.get("username"),
        "telegram_name": " ".join(
            p for p in (user.get("first_name"), user.get("last_name")) if p
        ),
        # то, что бот подставил в ссылку ?startapp=... — связка с диалогом/клиентом CRM
        "start_param": envelope.get("start_param"),
        "role": answers.get("role"),
        "grade": answers.get("grade"),
        "exam": answers.get("exam"),
        "goal_unit": answers.get("goal_unit"),
        "goal_avg": answers.get("goal_avg"),
        "preparation": answers.get("preparation"),
        "recommendation": answers.get("recommendation"),
        "subject_ids": [s.get("id") for s in subjects],
        "subjects_text": ", ".join(
            f"{s.get('name')} — {s.get('goal')} ({unit})" for s in subjects
        ),
        "filled_at": answers.get("ts"),
        "raw": answers,
    }


def forward(lead: dict, url: str, headers: dict, timeout: int = 10) -> int:
    body = json.dumps(lead, ensure_ascii=False).encode()
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json; charset=utf-8")
    for key, value in headers.items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status


class Handler(BaseHTTPRequestHandler):
    server_version = "umskul-webhook"

    # --- настройки берём из окружения в момент старта процесса ---
    bot_token = os.environ.get("BOT_TOKEN", "")
    forward_url = os.environ.get("FORWARD_URL", "")
    forward_headers = json.loads(os.environ.get("FORWARD_HEADERS", "{}"))
    allowed_origin = os.environ.get("ALLOWED_ORIGIN", "*")
    max_age = int(os.environ.get("INIT_DATA_MAX_AGE", "86400"))
    require_signature = os.environ.get("REQUIRE_SIGNATURE", "1") != "0"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", self.allowed_origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")

    def _reply(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 — имя задано BaseHTTPRequestHandler
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._reply(200, {"ok": True, "service": "umskul-webhook"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._reply(413, {"ok": False, "error": "bad body size"})
            return

        try:
            envelope = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._reply(400, {"ok": False, "error": "invalid json"})
            return

        tg_fields: dict = {}
        if self.require_signature:
            try:
                tg_fields = verify_init_data(
                    envelope.get("init_data") or "", self.bot_token, self.max_age
                )
            except ValueError as exc:
                log.warning("отклонён запрос: %s", exc)
                self._reply(401, {"ok": False, "error": str(exc)})
                return

        lead = build_lead(envelope, tg_fields)

        if self.forward_url:
            try:
                status = forward(lead, self.forward_url, self.forward_headers)
                log.info("лид %s переслан, статус %s", lead.get("telegram_id"), status)
            except (urllib.error.URLError, TimeoutError) as exc:
                log.error("не удалось переслать лид: %s", exc)
                self._reply(502, {"ok": False, "error": "forward failed"})
                return
        else:
            log.info("лид (пересылка не настроена): %s", json.dumps(lead, ensure_ascii=False))

        self._reply(200, {"ok": True})

    def log_message(self, fmt: str, *args) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if Handler.require_signature and not Handler.bot_token:
        raise SystemExit("Нужен BOT_TOKEN (или REQUIRE_SIGNATURE=0 для локального теста)")
    port = int(os.environ.get("PORT", "8080"))
    log.info("слушаем :%s, пересылка -> %s", port, Handler.forward_url or "(выключена)")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
