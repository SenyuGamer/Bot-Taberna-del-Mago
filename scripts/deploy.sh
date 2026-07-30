#!/usr/bin/env bash
#
# deploy.sh — Actualiza "La Taberna del Mago" en producción (idempotente).
#
#   Uso:  sudo bash /opt/taberna-mago/scripts/deploy.sh
#
# Qué hace (todas las veces, en orden):
#   1. Verifica que se ejecuta como root y que Node >= 22.13 / 23.4 / 24
#   2. git pull --ff-only (se omite si HEAD está detached — modo rollback)
#   3. Comprueba que existe .env
#   4. npm ci --omit=dev
#   5. Registra comandos en Discord solo si cambiaron archivos de comandos
#   6. Reinicia el servicio y verifica que queda activo
#   7. Si no arranca, muestra los últimos 20 logs
#
set -euo pipefail

APP_DIR="/opt/taberna-mago"
SERVICE="taberna-mago.service"

info()  { echo -e "\033[1;34m==>\033[0m $*"; }
ok()    { echo -e "\033[1;32m✅\033[0m $*"; }
error() { echo -e "\033[1;31m❌\033[0m $*" >&2; }

# ---------- 0. Prerequisitos ----------

if [ "$(id -u)" -ne 0 ]; then
  error "Ejecuta este script como root:  sudo bash $0"
  exit 1
fi

if [ ! -d "$APP_DIR" ]; then
  error "No existe $APP_DIR. Ejecuta primero scripts/install.sh"
  exit 1
fi

info "Verificando versión de Node.js..."
if ! command -v node >/dev/null 2>&1; then
  error "Node.js no está instalado. Se requiere 22.13+ (ver README_DEPLOY.md)."
  exit 1
fi
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"
# node:sqlite sin flag experimental requiere 22.13+ / 23.4+ / 24+
if [ "$NODE_MAJOR" -gt 23 ] \
  || { [ "$NODE_MAJOR" -eq 23 ] && [ "$NODE_MINOR" -ge 4 ]; } \
  || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 13 ]; }; then
  ok "Node v$NODE_VERSION"
else
  error "Node v$NODE_VERSION es insuficiente: se requiere 22.13+ / 23.4+ / 24+ (por node:sqlite)."
  exit 1
fi

cd "$APP_DIR"

# ---------- 1. Código ----------

if [ ! -d .git ]; then
  error "$APP_DIR no es un repositorio git. Clona el repo ahí (ver README_DEPLOY.md)."
  exit 1
fi

# Git >= 2.35 bloquea repos cuyo dueño es otro usuario (el deploy corre como
# root y el código quedó con dueño orangepi). Excepción segura e idempotente:
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" \
  || git config --global --add safe.directory "$APP_DIR"

COMMIT_ANTES="$(git rev-parse HEAD)"

if git symbolic-ref -q HEAD >/dev/null; then
  info "git pull --ff-only"
  git pull --ff-only
else
  info "HEAD detached (rollback manual): se omite git pull y se despliega lo que hay."
fi

COMMIT_DESPUES="$(git rev-parse HEAD)"
[ "$COMMIT_ANTES" = "$COMMIT_DESPUES" ] && info "Sin cambios de código (idempotente)."

# ---------- 2. Configuración ----------

info "Comprobando .env..."
if [ ! -f .env ]; then
  error "Falta $APP_DIR/.env — el servicio NO se reiniciará para no romper lo que funciona."
  error "Créalo (puedes partir de .env.example) y vuelve a ejecutar este script."
  exit 1
fi
ok ".env presente"

# ---------- 3. Dependencias ----------

info "npm ci --omit=dev"
npm ci --omit=dev

# Stub RISC-V: @snazzah/davey no tiene binario para riscv64
if [ -f "$APP_DIR/node_modules/@snazzah/davey/index.js" ]; then
  info "Inyectando stub de @snazzah/davey para RISC-V..."
  cp "$APP_DIR/scripts/davey-stub.js" "$APP_DIR/node_modules/@snazzah/davey/index.js"
  ok "Stub de davey inyectado"
fi

# ---------- 4. Comandos de Discord (solo si cambiaron) ----------

if [ "$COMMIT_ANTES" != "$COMMIT_DESPUES" ] \
  && ! git diff "$COMMIT_ANTES" "$COMMIT_DESPUES" --name-only | grep -qE '^(deploy\.js|src/commands/)'; then
  info "No cambiaron los comandos de Discord: se omite 'npm run deploy'."
else
  info "Registrando comandos de Discord (npm run deploy)..."
  npm run deploy
fi

# ---------- 5. Permisos de datos ----------

mkdir -p data
chown -R orangepi:orangepi data

# ---------- 6. Reinicio y verificación ----------

info "Reiniciando $SERVICE..."
systemctl restart "$SERVICE"
sleep 5

if systemctl is-active --quiet "$SERVICE"; then
  ok "$SERVICE activo y corriendo."
  echo
  systemctl status "$SERVICE" --no-pager -l | head -n 8
else
  error "$SERVICE no arrancó. Últimos 20 logs:"
  echo "----------------------------------------"
  journalctl -u "$SERVICE" -n 20 --no-pager
  echo "----------------------------------------"
  error "Revisa los logs de arriba, corrige y vuelve a ejecutar el deploy."
  exit 1
fi
