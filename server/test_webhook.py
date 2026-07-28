"""Тесты приёмника: подпись initData и сборка лида.

    python server/test_webhook.py
"""

import hashlib
import hmac
import json
import sys
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))

from webhook import build_lead, verify_init_data  # noqa: E402

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

    def test_lead_carries_verified_user_and_context(self):
        tg_fields = verify_init_data(sign(sample_fields()), TOKEN)
        lead = build_lead(self.envelope, tg_fields)
        self.assertEqual(lead["telegram_id"], 42)
        self.assertEqual(lead["telegram_name"], "Аня П.")
        self.assertEqual(lead["start_param"], "lead_777")
        self.assertEqual(lead["subject_ids"], ["soc", "hist"])
        self.assertEqual(
            lead["subjects_text"], "Обществознание — 90 (баллы), История — 90 (баллы)"
        )

    def test_marks_labelled_for_oge(self):
        envelope = json.loads(json.dumps(self.envelope))
        envelope["data"]["goal_unit"] = "mark"
        envelope["data"]["subjects"] = [{"id": "math", "name": "Математика", "goal": 5}]
        lead = build_lead(envelope, {})
        self.assertEqual(lead["subjects_text"], "Математика — 5 (оценка)")
        self.assertIsNone(lead["telegram_id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
