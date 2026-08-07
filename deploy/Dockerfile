# Приёмник ответов мини-аппа. Зависимостей нет — только стандартная библиотека,
# поэтому образ получается маленьким и собирается за секунды.
#
#   docker build -f deploy/Dockerfile -t umskul-webhook .
#   docker run -p 8080:8080 --env-file deploy/env.example umskul-webhook
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app
COPY server/ /app/server/

# не root: если контейнер скомпрометируют, прав будет меньше
RUN useradd --create-home --uid 10001 app
USER app

EXPOSE 8080

# health-check совпадает с GET / приёмника — он отвечает {"ok": true}
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/',timeout=4)"

CMD ["python", "server/webhook.py"]
