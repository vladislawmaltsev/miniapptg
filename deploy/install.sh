#!/usr/bin/env bash
# Установка приёмника на чистый VPS с Ubuntu 22.04/24.04 или Debian 12.
# Ставит сервис под systemd и Caddy, который сам получает сертификат Let's Encrypt.
#
# Запускать от root на сервере:
#
#   git clone https://github.com/<user>/<repo>.git /opt/umskul
#   bash /opt/umskul/deploy/install.sh api.example.com
#
# Перед запуском заведите A-запись домена на IP сервера — без неё Let's Encrypt
# не выдаст сертификат. Проверить: dig +short api.example.com
#
# Скрипт можно запускать повторно: он обновляет юнит и конфиг, но никогда
# не перезаписывает уже заполненный /etc/umskul-webhook.env.

set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="${APP_DIR:-/opt/umskul}"
ENV_FILE=/etc/umskul-webhook.env
SERVICE_USER=umskul

if [ -z "$DOMAIN" ]; then
	echo "Использование: bash $0 <домен>    например: bash $0 api.example.com" >&2
	exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
	echo "Нужны права root: sudo bash $0 $DOMAIN" >&2
	exit 1
fi

if [ ! -f "$APP_DIR/server/webhook.py" ]; then
	echo "Не вижу $APP_DIR/server/webhook.py — сначала склонируйте репозиторий в $APP_DIR" >&2
	exit 1
fi

echo "==> Ставим python3 и Caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 curl debian-keyring debian-archive-keyring apt-transport-https

if ! command -v caddy >/dev/null; then
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
		| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
		> /etc/apt/sources.list.d/caddy-stable.list
	apt-get update -qq
	apt-get install -y -qq caddy
fi

echo "==> Заводим пользователя $SERVICE_USER"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"

echo "==> Готовим $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
	cp "$APP_DIR/deploy/env.example" "$ENV_FILE"
	NEED_EDIT=1
else
	NEED_EDIT=0
	echo "    файл уже есть — оставляю как есть"
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

echo "==> Ставим systemd-юнит"
install -m 644 "$APP_DIR/deploy/umskul-webhook.service" /etc/systemd/system/umskul-webhook.service
# юнит в репозитории рассчитан на /opt/umskul; если каталог другой — поправим на месте
if [ "$APP_DIR" != "/opt/umskul" ]; then
	sed -i "s#/opt/umskul#$APP_DIR#g" /etc/systemd/system/umskul-webhook.service
fi
systemctl daemon-reload
systemctl enable umskul-webhook >/dev/null

echo "==> Настраиваем Caddy на $DOMAIN"
sed "s/api\.example\.com/$DOMAIN/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy
systemctl reload caddy || systemctl restart caddy

if [ "$NEED_EDIT" = "1" ]; then
	cat <<EOF

Осталось одно: вписать настройки в $ENV_FILE
(BOT_TOKEN, ALLOWED_ORIGIN, BM_TRIGGER_URL — что это, написано в самом файле).

    nano $ENV_FILE
    systemctl start umskul-webhook
    curl -i https://$DOMAIN/

EOF
else
	systemctl restart umskul-webhook
	echo
	echo "Готово. Проверка: curl -i https://$DOMAIN/"
	echo "Логи:     journalctl -u umskul-webhook -f"
	echo
fi
