"""Пример приёма ответов мини-аппа Умскул на стороне бота (aiogram 3).

Запуск:
    pip install aiogram
    BOT_TOKEN=123:ABC WEBAPP_URL=https://example.com/ python bot/bot.py

Важно: sendData() из мини-аппа приходит в апдейт web_app_data только если
приложение открыто кнопкой reply-клавиатуры (KeyboardButton с web_app).
"""

import asyncio
import json
import logging
import os

from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
from aiogram.types import (
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
    WebAppInfo,
)

BOT_TOKEN = os.environ["BOT_TOKEN"]
WEBAPP_URL = os.environ["WEBAPP_URL"]

ROLE = {"student": "Ученик", "parent": "Родитель"}
EXAM = {"ege": "ЕГЭ", "oge": "ОГЭ", "school": "школьная программа"}
PREP = {
    "none": "пока не готовится",
    "self": "готовится самостоятельно",
    "tutor": "занимается с репетитором",
    "umschool": "уже учится в Умскул",
}

dp = Dispatcher()


@dp.message(CommandStart())
async def start(message: Message) -> None:
    keyboard = ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="🎓 Подобрать программу", web_app=WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True,
    )
    await message.answer(
        "Привет! Ответьте на 5 коротких вопросов — подберём программу Умскул под вашу цель.",
        reply_markup=keyboard,
    )


@dp.message(F.web_app_data)
async def on_webapp_data(message: Message) -> None:
    try:
        data = json.loads(message.web_app_data.data)
    except json.JSONDecodeError:
        await message.answer("Не удалось прочитать ответы, попробуйте пройти анкету ещё раз.")
        return

    unit = "баллов" if data.get("goal_unit") == "score" else "оценка"
    subjects = "\n".join(
        f"• {s['name']} — {s['goal']} {unit}" for s in data.get("subjects", [])
    )

    text = (
        "<b>Анкета получена</b>\n\n"
        f"Кто: {ROLE.get(data.get('role'), '—')}\n"
        f"Класс: {data.get('grade')} ({EXAM.get(data.get('exam'), '—')})\n"
        f"Подготовка: {PREP.get(data.get('preparation'), '—')}\n\n"
        f"<b>Предметы и цели</b>\n{subjects or '—'}\n\n"
        f"<i>{data.get('recommendation', '')}</i>\n\n"
        "Куратор свяжется с вами и предложит подходящий курс."
    )
    await message.answer(text, parse_mode="HTML", reply_markup=ReplyKeyboardRemove())

    # Здесь: сохранить лид в CRM / отправить в отдел продаж.
    logging.info("lead from %s: %s", message.from_user.id, data)


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    bot = Bot(BOT_TOKEN)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
