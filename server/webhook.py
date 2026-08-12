"""Приёмник ответов мини-аппа Умскул -> bot-marketing -> retailCRM.

Мини-апп, открытый по прямой ссылке (t.me/<bot>/<app>), не может использовать
sendData(), поэтому ответы уходят обычным POST сюда. Сервис проверяет подпись
Telegram initData и доставляет анкету в сценарий бот-конструктора, который уже
пишет её в кастомные поля клиента retailCRM действием «Обновить контакт».

Два способа доставки (пробуются по очереди, см. DELIVERY):

  session — POST {BM_API_BASE}/tunnelSessions/<hash>/request
            code=<BM_REQUEST_CODE>&params[role]=...&params[grade]=...
            Сценарий должен стоять на шаге, ожидающем внешний запрос.
            В сценарии значения доступны как @{externalRequest.role} и т.д.
            Ссылку на мини-апп бот отдаёт с ?startapp=@{scenarioSession.hash}

  trigger — POST на URL триггера вида
            https://<инстанс>/l/h/<код триггера>/c/<chat.hash>
            Работает, даже если сессия сценария уже завершилась.
            Значения доступны в триггере как @{query.role} и т.д.
            Ссылку на мини-апп бот отдаёт с ?startapp=@{chat.hash}

Запуск (зависимостей нет, только стандартная библиотека):

    BOT_TOKEN=123:ABC \
    ALLOWED_ORIGIN=https://<user>.github.io \
    BM_REQUEST_CODE=quiz \
    BM_TRIGGER_URL='https://retailcrm.bot-marketing.com/l/h/Mw5pUBba/c/{chat_hash}' \
    python server/webhook.py

Переменные окружения:
    BOT_TOKEN           токен бота из BotFather — для проверки подписи initData
    ALLOWED_ORIGIN      Origin мини-аппа для CORS ('*' по умолчанию)
    INIT_DATA_MAX_AGE   срок годности initData в секундах (по умолчанию 86400)
    REQUIRE_SIGNATURE   '0' отключает проверку подписи (только для локальных тестов)
    PORT                порт (по умолчанию 8080)

    DELIVERY            auto (по умолчанию) | session | trigger | forward | log
    START_PARAM_FORMAT  что бот кладёт в ?startapp=:
                        session (по умолчанию) | chat | session-chat
    BM_API_BASE         база API сессий, по умолчанию
                        https://console.bot-marketing.com/api/public
    BM_REQUEST_CODE     код внешнего запроса в сценарии (по умолчанию 'quiz')
    BM_RETURN_RESPONSE  '1' — ждать нового состояния сессии, '0' (по умолчанию) — нет
    BM_TRIGGER_URL      URL триггера с подстановкой {chat_hash}
    FORWARD_URL         запасной приёмник: туда уйдёт лид целиком в JSON
    FORWARD_HEADERS     JSON с доп. заголовками для FORWARD_URL
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
from urllib.parse import parse_qsl, urlencode

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


ROLE_TEXT = {"student": "Ученик", "parent": "Родитель"}
EXAM_TEXT = {"ege": "ЕГЭ", "oge": "ОГЭ", "school": "Школьная программа"}
PREP_TEXT = {
    "none": "Пока никак",
    "self": "Готовится самостоятельно",
    "tutor": "С репетитором",
    "school": "Будет готовиться в школе",
    "umschool": "Уже в Умскул",
}
UNIT_TEXT = {"score": "баллы", "mark": "оценка"}
TRACK_TEXT = {"express": "Экспресс-диагностика", "full": "Подробная диагностика"}
# junior — анкета оборвана на 5–6 классе, лид уведён в канал средней школы;
# по этому полю сценарий отличает такие лиды от полностью заполненных анкет
OUTCOME_TEXT = {
    "completed": "Анкета заполнена",
    "junior": "5–6 класс, средняя школа",
}
LEVEL_TEXT = {
    "gaps": "Есть западающие темы",
    "structure": "Нет структуры в знаниях",
    "zero": "Хочет изучить всё с нуля",
}
ONLINE_TEXT = {
    "liked": "Был опыт, понравилось",
    "disliked": "Был опыт, не понравилось",
    "quit": "Пробовал(а), но забросил(а)",
    "never": "Опыта не было",
}
PRIORITY_TEXT = {
    "explain": "Понятное объяснение тем",
    "practice": "Много практики и разборов",
    "homework": "Проверка домашки с обратной связью",
    "control": "Контроль и дисциплина",
    "motivation": "Мотивация и поддержка",
    "tactics": "Тактика и лайфхаки на экзамене",
    "schedule": "Удобное расписание",
    "price": "Доступная цена",
}

# Ошибки сессии, при которых имеет смысл упасть на запасной канал (триггер):
# сценарий уже завершился или не ждёт наш запрос.
SESSION_FALLBACK_ERRORS = {
    "not_expecting_requests",
    "request_not_matched",
    "session_not_active",
    "inner_session_forced_exit",
    "request_conditions_not_met",
}


class DeliveryError(Exception):
    """Не удалось доставить анкету. fallback=True — можно пробовать другой канал."""

    def __init__(self, message: str, fallback: bool = False):
        super().__init__(message)
        self.fallback = fallback


class Settings:
    """Настройки доставки. Читаются из окружения, в тестах задаются вручную."""

    def __init__(self, **kw):
        self.delivery = kw.get("delivery", "auto")
        self.start_param_format = kw.get("start_param_format", "session")
        self.bm_api_base = kw.get("bm_api_base", "https://console.bot-marketing.com/api/public")
        self.bm_request_code = kw.get("bm_request_code", "quiz")
        self.bm_return_response = kw.get("bm_return_response", "0")
        self.bm_trigger_url = kw.get("bm_trigger_url", "")
        self.forward_url = kw.get("forward_url", "")
        self.forward_headers = kw.get("forward_headers", {})
        self.timeout = kw.get("timeout", 10)

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            delivery=os.environ.get("DELIVERY", "auto"),
            start_param_format=os.environ.get("START_PARAM_FORMAT", "session"),
            bm_api_base=os.environ.get(
                "BM_API_BASE", "https://console.bot-marketing.com/api/public"
            ).rstrip("/"),
            bm_request_code=os.environ.get("BM_REQUEST_CODE", "quiz"),
            bm_return_response=os.environ.get("BM_RETURN_RESPONSE", "0"),
            bm_trigger_url=os.environ.get("BM_TRIGGER_URL", ""),
            forward_url=os.environ.get("FORWARD_URL", ""),
            forward_headers=json.loads(os.environ.get("FORWARD_HEADERS", "{}")),
            timeout=int(os.environ.get("DELIVERY_TIMEOUT", "10")),
        )


def split_start_param(start_param: str, fmt: str = "session") -> dict:
    """Достаёт из ?startapp= хэш сессии сценария и/или хэш чата.

    Бот подставляет в ссылку @{scenarioSession.hash} и/или @{chat.hash};
    Telegram разрешает в startapp только A-Za-z0-9_-, поэтому в режиме
    session-chat хэши склеены дефисом: <сессия>-<чат>.
    """
    value = (start_param or "").strip()
    if not value:
        return {"session_hash": None, "chat_hash": None}
    if fmt == "chat":
        return {"session_hash": None, "chat_hash": value}
    if fmt == "session-chat":
        session, _, chat = value.partition("-")
        return {"session_hash": session or None, "chat_hash": chat or None}
    return {"session_hash": value, "chat_hash": None}


def build_lead(envelope: dict, tg_fields: dict) -> dict:
    """Плоский лид: ответы анкеты, читаемые подписи и подтверждённый Telegram-профиль.

    Читаемые значения (*_text) уходят прямо в кастомные поля retailCRM,
    машинные коды остаются для условий в сценарии.
    """
    answers = envelope.get("data") or {}
    user = tg_fields.get("user") or {}
    subjects = answers.get("subjects") or []
    # предметы, по которым лид уже занимается у нас: только у ответивших «Уже в Умскул»
    current = answers.get("current_subjects") or []
    unit = UNIT_TEXT.get(answers.get("goal_unit"), "")
    priorities = answers.get("priorities") or []

    return {
        "track": answers.get("track"),
        "track_text": TRACK_TEXT.get(answers.get("track"), ""),
        "outcome": answers.get("outcome") or "completed",
        "outcome_text": OUTCOME_TEXT.get(answers.get("outcome") or "completed", ""),
        "telegram_id": user.get("id"),
        "telegram_username": user.get("username"),
        "telegram_name": " ".join(
            p for p in (user.get("first_name"), user.get("last_name")) if p
        ),
        "role": answers.get("role"),
        "role_text": ROLE_TEXT.get(answers.get("role"), ""),
        "grade": answers.get("grade"),
        "exam": answers.get("exam"),
        "exam_text": EXAM_TEXT.get(answers.get("exam"), ""),
        "goal_unit": answers.get("goal_unit"),
        "goal_unit_text": unit,
        "goal_avg": answers.get("goal_avg"),
        "level": answers.get("level"),
        "level_text": LEVEL_TEXT.get(answers.get("level"), ""),
        "priorities": priorities,
        "priorities_text": ", ".join(PRIORITY_TEXT.get(p, p) for p in priorities),
        "preparation": answers.get("preparation"),
        "preparation_text": PREP_TEXT.get(answers.get("preparation"), ""),
        "online_experience": answers.get("online_experience"),
        "online_experience_text": ONLINE_TEXT.get(answers.get("online_experience"), ""),
        "recommendation": answers.get("recommendation"),
        "subject_ids": [s.get("id") for s in subjects],
        "subjects": ", ".join(str(s.get("name")) for s in subjects),
        "current_subject_ids": [s.get("id") for s in current],
        "current_subjects": ", ".join(str(s.get("name")) for s in current),
        "goals_text": ", ".join(f"{s.get('name')} — {s.get('goal')}" for s in subjects),
        "subjects_count": len(subjects),
        "filled_at": answers.get("ts"),
        "raw": answers,
    }


def to_params(lead: dict) -> dict:
    """Строковые параметры для сценария или триггера (пустые поля не шлём)."""
    params = {}
    for key, value in lead.items():
        if key == "raw" or value is None or value == "" or value == []:
            continue
        params[key] = ",".join(str(v) for v in value) if isinstance(value, list) else str(value)
    return params


def post_form(url: str, fields: dict, timeout: int = 10) -> tuple:
    body = urlencode(fields).encode()
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read(4096).decode("utf-8", "replace")


def post_json(url: str, payload: dict, headers: dict, timeout: int = 10) -> tuple:
    body = json.dumps(payload, ensure_ascii=False).encode()
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json; charset=utf-8")
    for key, value in headers.items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read(4096).decode("utf-8", "replace")


def response_error_code(body: str) -> str:
    """Достаёт код ошибки из ответа бот-конструктора, если он там есть."""
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, TypeError):
        return ""
    if not isinstance(parsed, dict):
        return ""
    for key in ("error", "errorCode", "code", "statusName"):
        value = parsed.get(key)
        if isinstance(value, str) and value in SESSION_FALLBACK_ERRORS:
            return value
    return ""


def deliver_session(params: dict, session_hash: str, cfg: Settings) -> str:
    """Внешний запрос к сессии сценария: он ждёт его на шаге и продолжит диалог."""
    if not session_hash:
        raise DeliveryError("нет хэша сессии в start_param", fallback=True)

    fields = {"code": cfg.bm_request_code, "returnResponse": cfg.bm_return_response}
    fields.update({f"params[{k}]": v for k, v in params.items()})
    url = f"{cfg.bm_api_base}/tunnelSessions/{session_hash}/request"

    try:
        status, body = post_form(url, fields, cfg.timeout)
    except urllib.error.HTTPError as exc:
        detail = exc.read(4096).decode("utf-8", "replace")
        # сценарий не ждёт запрос или сессия закрыта — это повод пойти в триггер
        raise DeliveryError(
            f"сессия ответила {exc.code}: {detail[:200]}",
            fallback=bool(response_error_code(detail)) or exc.code in (404, 409, 410, 422),
        )
    except (urllib.error.URLError, TimeoutError) as exc:
        raise DeliveryError(f"сессия недоступна: {exc}", fallback=True)

    error = response_error_code(body)
    if error:
        raise DeliveryError(f"сценарий отклонил запрос: {error}", fallback=True)
    log.info("анкета доставлена в сессию %s, статус %s", session_hash, status)
    return "session"


def deliver_trigger(params: dict, chat_hash: str, cfg: Settings) -> str:
    """Триггер по ссылке: работает и после завершения сессии сценария."""
    if not cfg.bm_trigger_url:
        raise DeliveryError("BM_TRIGGER_URL не задан", fallback=True)
    if "{chat_hash}" in cfg.bm_trigger_url and not chat_hash:
        raise DeliveryError("нет хэша чата в start_param", fallback=True)

    url = cfg.bm_trigger_url.replace("{chat_hash}", chat_hash or "")
    try:
        status, _ = post_form(url, params, cfg.timeout)
    except urllib.error.HTTPError as exc:
        raise DeliveryError(f"триггер ответил {exc.code}", fallback=True)
    except (urllib.error.URLError, TimeoutError) as exc:
        raise DeliveryError(f"триггер недоступен: {exc}", fallback=True)

    log.info("анкета доставлена триггером, статус %s", status)
    return "trigger"


def deliver_forward(lead: dict, cfg: Settings) -> str:
    if not cfg.forward_url:
        raise DeliveryError("FORWARD_URL не задан", fallback=True)
    try:
        status, _ = post_json(cfg.forward_url, lead, cfg.forward_headers, cfg.timeout)
    except (urllib.error.URLError, TimeoutError) as exc:
        raise DeliveryError(f"приёмник недоступен: {exc}", fallback=True)
    log.info("лид переслан на FORWARD_URL, статус %s", status)
    return "forward"


def deliver(lead: dict, start_param: str, cfg: Settings) -> str:
    """Пробует каналы по очереди и возвращает тот, который сработал."""
    hashes = split_start_param(start_param, cfg.start_param_format)
    params = to_params(lead)

    if cfg.delivery == "log":
        log.info("лид (доставка выключена): %s", json.dumps(lead, ensure_ascii=False))
        return "log"

    order = {
        "auto": ["session", "trigger", "forward"],
        "session": ["session"],
        "trigger": ["trigger"],
        "forward": ["forward"],
    }.get(cfg.delivery, ["session", "trigger", "forward"])

    last: DeliveryError = DeliveryError("не настроен ни один канал доставки")
    for channel in order:
        try:
            if channel == "session":
                return deliver_session(params, hashes["session_hash"], cfg)
            if channel == "trigger":
                return deliver_trigger(params, hashes["chat_hash"], cfg)
            return deliver_forward(lead, cfg)
        except DeliveryError as exc:
            log.warning("канал %s не сработал: %s", channel, exc)
            last = exc
            if not exc.fallback:
                break
    raise last


SETTINGS = Settings.from_env()


class Handler(BaseHTTPRequestHandler):
    server_version = "umskul-webhook"

    # --- настройки берём из окружения в момент старта процесса ---
    bot_token = os.environ.get("BOT_TOKEN", "")
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

        try:
            channel = deliver(lead, envelope.get("start_param"), SETTINGS)
        except DeliveryError as exc:
            log.error("анкета не доставлена: %s", exc)
            self._reply(502, {"ok": False, "error": "delivery failed"})
            return

        self._reply(200, {"ok": True, "channel": channel})

    def log_message(self, fmt: str, *args) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if Handler.require_signature and not Handler.bot_token:
        raise SystemExit("Нужен BOT_TOKEN (или REQUIRE_SIGNATURE=0 для локального теста)")
    port = int(os.environ.get("PORT", "8080"))
    log.info("слушаем :%s, доставка: %s", port, SETTINGS.delivery)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
