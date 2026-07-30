#!/usr/bin/env bash
#
# install.sh — Primera instalación de "La Taberna del Mago" en Orange Pi.
#
#   Uso:  sudo bash scripts/install.sh      (desde cualquier clon del repo)
#
# Qué hace (idempotente: se puede repetir sin miedo):
#   1. Verifica root, Node >= 22.13 / 23.4 / 24 y crea el usuario orangepi si falta
#   2. Copia el proyecto a /opt/taberna-mago (sin .git, node_modules, data ni .env)
#   3. npm ci --omit=dev
#   4. Comprueba que existe /opt/taberna-mago/.env (si no, deja plantilla y explica)
#   5. Instala el servicio systemd y lo deja habilitado con `systemctl enable --now`
#   6. Si no arranca, muestra los últimos 20 logs
#
set -euo pipefail

APP_DIR="/opt/taberna-mago"
SERVICE="taberna-mago.service"
SERVICE_USER="orangepi"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

info()  { echo -e "\033[1;34m==>\033[0m $*"; }
ok()    { echo -e "\033[1;32m✅\033[0m $*"; }
error() { echo -e "\033[1;31m❌\033[0m $*" >&2; }

# ---------- 0. Prerequisitos ----------

if [ "$(id -u)" -ne 0 ]; then
  error "Ejecuta este script como root:  sudo bash $0"
  exit 1
fi

info "Verificando versión de Node.js..."
if ! command -v node >/dev/null 2>&1; then
  error "Node.js no está instalado."
  error "Instala 22.13+ con:  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"
  error "(Cualquier Node >= 22.13 / 23.4 / 24 sirve; ver README_DEPLOY.md)"
  exit 1
fi
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"
if [ "$NODE_MAJOR" -gt 23 ] \
  || { [ "$NODE_MAJOR" -eq 23 ] && [ "$NODE_MINOR" -ge 4 ]; } \
  || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 13 ]; }; then
  ok "Node v$NODE_VERSION"
else
  error "Node v$NODE_VERSION es insuficiente: se requiere 22.13+ / 23.4+ / 24+ (por node:sqlite)."
  exit 1
fi

# ---------- 1. Usuario del servicio ----------

if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "Usuario $SERVICE_USER ya existe"
else
  info "Creando usuario $SERVICE_USER..."
  useradd -m -s /bin/bash "$SERVICE_USER"
  ok "Usuario $SERVICE_USER creado"
fi

# ---------- 2. Código en /opt/taberna-mago ----------

# Git >= 2.35 bloquea repos cuyo dueño es otro usuario (los futuros deploys
# corren como root y el código quedará con dueño orangepi). Excepción idempotente:
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" \
  || git config --global --add safe.directory "$APP_DIR"

mkdir -p "$APP_DIR"

if [ "$SRC_DIR" = "$APP_DIR" ]; then
  info "El proyecto ya está en $APP_DIR (se omite la copia)."
else
  info "Copiando proyecto de $SRC_DIR a $APP_DIR..."
  # Nunca copiamos: git, node_modules, datos en ejecución ni secretos
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.git' --exclude 'node_modules' --exclude 'data' --exclude '.env' \
      "$SRC_DIR/" "$APP_DIR/"
  else
    cp -a "$SRC_DIR/." "$APP_DIR/"
    rm -rf "$APP_DIR/.git" "$APP_DIR/node_modules" "$APP_DIR/data"
    rm -f "$APP_DIR/.env"
  fi
  ok "Proyecto copiado"
fi

# ---------- 3. Dependencias ----------

info "npm ci --omit=dev (en $APP_DIR)"
cd "$APP_DIR"
npm ci --omit=dev

# Stub RISC-V: @snazzah/davey no tiene binario para riscv64
if [ -f "$APP_DIR/node_modules/@snazzah/davey/index.js" ]; then
  info "Inyectando stub de @snazzah/davey para RISC-V..."
  cp "$APP_DIR/scripts/davey-stub.js" "$APP_DIR/node_modules/@snazzah/davey/index.js"
  ok "Stub de davey inyectado"
fi

# ---------- 4. Configuración (.env) ----------

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/.env"
  error "No existía $APP_DIR/.env: he dejado una plantilla."
  error "Edítala con los tokens reales:"
  error "    nano $APP_DIR/.env"
  error "Y vuelve a ejecutar este script para terminar la instalación."
  exit 1
fi

# ---------- 5. Permisos ----------

info "Asignando propiedad de $APP_DIR a $SERVICE_USER..."
mkdir -p "$APP_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# ---------- 6. Servicio systemd ----------

info "Instalando $SERVICE..."
cp "$APP_DIR/$SERVICE" "/etc/systemd/system/$SERVICE"
systemctl daemon-reload

info "Habilitando y arrancando el servicio (systemctl enable --now)..."
systemctl enable --now "$SERVICE"
sleep 5

if systemctl is-active --quiet "$SERVICE"; then
  echo
  ok "¡Instalación completa! $SERVICE está activo:"
  echo
  systemctl status "$SERVICE" --no-pager -l | head -n 8
  echo
  echo "  Logs en directo:  journalctl -u $SERVICE -f"
  echo "  Actualizaciones:  sudo bash $APP_DIR/scripts/deploy.sh"
else
  error "$SERVICE no arrancó. Últimos 20 logs:"
  echo "----------------------------------------"
  journalctl -u "$SERVICE" -n 20 --no-pager
  echo "----------------------------------------"
  error "Causas habituales: .env incompleto, token inválido o reloj desincronizado (revisa: timedatectl)."
  exit 1
fi
