"""Тесты приёмника: подпись initData и сборка лида.

    python server/test_webhook.py
"""

import hashlib
import hmac
import json
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))

from webhook import (  # noqa: E402
    DeliveryError,
    Settings,
    build_lead,
    deliver,
    split_start_param,
    to_params,
    verify_init_data,
)

TOKEN = "123456:TEST-TOKEN"


def sign(fields: dict, token: str = TOKEN) -> str:
    """Собирает initData так же, как это делает клиент Telegram."""
    check_string = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    digest = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode({**fields, "hash": digest})


def sample_fields(**overrides) -> dict:
    fields = {
        "auth_date": str(int(time.time())),
        "query_id": "AAH-test",
        "user": json.dumps(
            {"id": 42, "first_name": "Аня", "last_name": "П.", "username": "anya"},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    }
    fields.update(overrides)
    return fields


class VerifyInitData(unittest.TestCase):
    def test_valid_signature_returns_user(self):
        fields = verify_init_data(sign(sample_fields()), TOKEN)
        self.assertEqual(fields["user"]["id"], 42)
        self.assertEqual(fields["user"]["username"], "anya")

    def test_tampered_payload_rejected(self):
        # подменяем пользователя, оставляя исходную подпись
        fields = sample_fields()
        original_hash = dict(parse_qsl(sign(fields)))["hash"]
        fields["user"] = json.dumps({"id": 999, "first_name": "Чужой"}, ensure_ascii=False)
        with self.assertRaises(ValueError):
            verify_init_data(urlencode({**fields, "hash": original_hash}), TOKEN)

    def test_foreign_token_rejected(self):
        with self.assertRaises(ValueError):
            verify_init_data(sign(sample_fields()), "999:OTHER-TOKEN")

    def test_missing_hash_rejected(self):
        with self.assertRaises(ValueError):
            verify_init_data(urlencode(sample_fields()), TOKEN)

    def test_expired_init_data_rejected(self):
        old = sample_fields(auth_date=str(int(time.time()) - 90000))
        with self.assertRaises(ValueError):
            verify_init_data(sign(old), TOKEN, max_age=86400)

    def test_expiry_check_can_be_disabled(self):
        old = sample_fields(auth_date=str(int(time.time()) - 90000))
        self.assertIn("user", verify_init_data(sign(old), TOKEN, max_age=0))


class BuildLead(unittest.TestCase):
    envelope = {
        "init_data": "",
        "start_param": "lead_777",
        "data": {
            "role": "parent",
            "grade": 10,
            "exam": "ege",
            "goal_unit": "score",
            "goal_avg": 90,
            "preparation": "tutor",
            "recommendation": "Рекомендуем интенсив на 90+",
            "subjects": [
                {"id": "soc", "name": "Обществознание", "goal": 90},
                {"id": "hist", "name": "История", "goal": 90},
            ],
            "ts": "2026-07-27T22:10:29.458Z",
        },
    }

    def test_lead_carries_verified_user_and_readable_values(self):
        tg_fields = verify_init_data(sign(sample_fields()), TOKEN)
        lead = build_lead(self.envelope, tg_fields)
        self.assertEqual(lead["telegram_id"], 42)
        self.assertEqual(lead["telegram_name"], "Аня П.")
        self.assertEqual(lead["subject_ids"], ["soc", "hist"])
        self.assertEqual(lead["subjects"], "Обществознание, История")
        self.assertEqual(lead["goals_text"], "Обществознание — 90, История — 90")
        self.assertEqual(lead["subjects_count"], 2)
        # читаемые подписи — это то, что уедет в кастомные поля retailCRM
        self.assertEqual(lead["role_text"], "Родитель")
        self.assertEqual(lead["exam_text"], "ЕГЭ")
        self.assertEqual(lead["preparation_text"], "С репетитором")
        self.assertEqual(lead["goal_unit_text"], "баллы")

    def test_marks_labelled_for_oge(self):
        envelope = json.loads(json.dumps(self.envelope))
        envelope["data"]["goal_unit"] = "mark"
        envelope["data"]["exam"] = "oge"
        envelope["data"]["preparation"] = "none"
        envelope["data"]["subjects"] = [{"id": "math", "name": "Математика", "goal": 5}]
        lead = build_lead(envelope, {})
        self.assertEqual(lead["goals_text"], "Математика — 5")
        self.assertEqual(lead["goal_unit_text"], "оценка")
        self.assertEqual(lead["exam_text"], "ОГЭ")
        self.assertEqual(lead["preparation_text"], "Пока никак")
        self.assertIsNone(lead["telegram_id"])


class StubBotMarketing(BaseHTTPRequestHandler):
    """Изображает API бот-конструктора: пишет запросы в StubBotMarketing.calls."""

    calls: list = []
    session_status = 200
    session_body = '{"statusName": "active"}'

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode()
        type(self).calls.append({"path": self.path, "fields": dict(parse_qsl(body))})

        if "/tunnelSessions/" in self.path:
            status, payload = type(self).session_status, type(self).session_body
        else:
            status, payload = 200, "ok"

        raw = payload.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):
        pass


class Delivery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), StubBotMarketing)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        StubBotMarketing.calls = []
        StubBotMarketing.session_status = 200
        StubBotMarketing.session_body = '{"statusName": "active"}'
        self.lead = build_lead(BuildLead.envelope, verify_init_data(sign(sample_fields()), TOKEN))

    def settings(self, **kw):
        defaults = dict(
            bm_api_base=f"{self.base}/api/public",
            bm_request_code="quiz",
            bm_trigger_url=f"{self.base}/l/h/TRIG/c/{{chat_hash}}",
        )
        defaults.update(kw)
        return Settings(**defaults)

    def test_session_request_carries_code_and_params(self):
        channel = deliver(self.lead, "SESSIONHASH", self.settings())
        self.assertEqual(channel, "session")
        call = StubBotMarketing.calls[0]
        self.assertEqual(call["path"], "/api/public/tunnelSessions/SESSIONHASH/request")
        self.assertEqual(call["fields"]["code"], "quiz")
        self.assertEqual(call["fields"]["returnResponse"], "0")
        self.assertEqual(call["fields"]["params[role_text]"], "Родитель")
        self.assertEqual(call["fields"]["params[exam_text]"], "ЕГЭ")
        self.assertEqual(call["fields"]["params[grade]"], "10")
        self.assertEqual(call["fields"]["params[subject_ids]"], "soc,hist")
        self.assertEqual(call["fields"]["params[telegram_id]"], "42")
        self.assertNotIn("params[raw]", call["fields"])

    def test_falls_back_to_trigger_when_scenario_not_waiting(self):
        StubBotMarketing.session_body = '{"error": "not_expecting_requests"}'
        channel = deliver(self.lead, "SESS-CHATHASH", self.settings(start_param_format="session-chat"))
        self.assertEqual(channel, "trigger")
        self.assertEqual(len(StubBotMarketing.calls), 2)
        trigger_call = StubBotMarketing.calls[1]
        self.assertEqual(trigger_call["path"], "/l/h/TRIG/c/CHATHASH")
        self.assertEqual(trigger_call["fields"]["role_text"], "Родитель")
        self.assertNotIn("code", trigger_call["fields"])

    def test_session_error_status_also_falls_back(self):
        StubBotMarketing.session_status = 404
        StubBotMarketing.session_body = '{"error": "session_not_active"}'
        channel = deliver(self.lead, "SESS-CHATHASH", self.settings(start_param_format="session-chat"))
        self.assertEqual(channel, "trigger")

    def test_forced_session_mode_does_not_use_trigger(self):
        StubBotMarketing.session_body = '{"error": "session_not_active"}'
        with self.assertRaises(DeliveryError):
            deliver(self.lead, "SESSIONHASH", self.settings(delivery="session"))
        self.assertEqual(len(StubBotMarketing.calls), 1)

    def test_chat_only_start_param_goes_straight_to_trigger(self):
        channel = deliver(self.lead, "CHATHASH", self.settings(start_param_format="chat"))
        self.assertEqual(channel, "trigger")
        self.assertEqual(StubBotMarketing.calls[0]["path"], "/l/h/TRIG/c/CHATHASH")

    def test_delivery_log_mode_sends_nothing(self):
        self.assertEqual(deliver(self.lead, "SESSIONHASH", self.settings(delivery="log")), "log")
        self.assertEqual(StubBotMarketing.calls, [])


class StartParam(unittest.TestCase):
    def test_session_format(self):
        self.assertEqual(
            split_start_param("abc123"), {"session_hash": "abc123", "chat_hash": None}
        )

    def test_chat_format(self):
        self.assertEqual(
            split_start_param("abc123", "chat"), {"session_hash": None, "chat_hash": "abc123"}
        )

    def test_combined_format_splits_on_first_dash(self):
        self.assertEqual(
            split_start_param("sess-chat", "session-chat"),
            {"session_hash": "sess", "chat_hash": "chat"},
        )

    def test_empty_start_param(self):
        self.assertEqual(split_start_param(None), {"session_hash": None, "chat_hash": None})


class Params(unittest.TestCase):
    def test_empty_values_are_dropped(self):
        params = to_params({"a": "x", "b": None, "c": "", "d": [], "e": 0, "raw": {"k": 1}})
        self.assertEqual(params, {"a": "x", "e": "0"})

    def test_lists_become_csv(self):
        self.assertEqual(to_params({"ids": ["a", "b"]})["ids"], "a,b")


if __name__ == "__main__":
    unittest.main(verbosity=2)
