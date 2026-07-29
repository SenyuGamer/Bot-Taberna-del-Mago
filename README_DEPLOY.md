# 🍺 Despliegue en producción — Orange Pi (Ubuntu 24.04 ARM64 + systemd)

Guía completa para instalar, actualizar y operar **La Taberna del Mago** en una Orange Pi.

- **Sin PM2, sin Docker**: Node puro + systemd.
- **Sin puertos abiertos**: el bot solo hace conexiones *salientes* (Discord y Twitch). No hay que tocar el firewall.
- **Todo el estado vive en `/opt/taberna-mago/data/`** (SQLite + tokens de Twitch) — nunca se toca en los despliegues.

---

## Requisitos

| Requisito | Detalle |
|---|---|
| SO | Ubuntu 24.04 ARM64 |
| Node.js | **22.13+ / 23.4+ / 24+** (la base de datos usa `node:sqlite`, que en versiones anteriores va detrás de un flag experimental). El `nodejs` de apt suele ser demasiado viejo: usa NodeSource. |
| systemd | Incluido en Ubuntu |
| Reloj | NTP activo (`timedatectl` → `System clock synchronized: yes`). OAuth/TLS fallan con el reloj desviado. |

Instalación recomendada de Node (una vez):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
node --version   # debe ser >= v22.13
```

---

## 1. Instalación inicial (una sola vez)

```bash
# 1. Clona el proyecto (en tu home, por ejemplo)
git clone <url-del-repo> taberna-mago
cd taberna-mago

# 2. PREPARA EL .env ANTES DE INSTALAR: cópialo al destino
#    (el script de instalación lo exige para arrancar el servicio)
sudo mkdir -p /opt/taberna-mago
sudo cp .env.example /opt/taberna-mago/.env
sudo nano /opt/taberna-mago/.env   # rellena DISCORD_TOKEN, CLIENT_ID y GUILD_ID

# 3. Instala (verifica Node, copia código, npm ci --omit=dev, instala y arranca el servicio)
sudo bash scripts/install.sh
```

`install.sh` es **idempotente**: puedes repetirlo sin riesgo. Si falla, te muestra los últimos 20 logs y la causa probable.

> **No copies tu `.env` dentro del git** — va solo en `/opt/taberna-mago/.env`, fuera del repositorio (está en `.gitignore`).

### Sincronizar Twitch en un servidor headless (opcional)

El comando `/sincronizar twitch` levanta un servidor temporal en `localhost:3456` **de la Pi**. Para que el callback llegue desde tu PC, abre un túnel SSH **antes** de autorizar en el navegador:

```bash
# En tu PC (déjalo abierto mientras autorizas):
ssh -L 3456:localhost:3456 orangepi@<ip-de-la-pi>
```

Y luego, en Discord: `/sincronizar twitch` → abre el enlace → listo. Los tokens quedan en `/opt/taberna-mago/data/twitch-token.json` y **se renuevan solos** cada ~3.5 h.

---

## 2. Actualización (cada vez que haya cambios)

```bash
sudo bash /opt/taberna-mago/scripts/deploy.sh
```

El deploy es **idempotente** y hace: verificación de Node → `git pull --ff-only` → check de `.env` → `npm ci --omit=dev` → registro de comandos de Discord **solo si cambiaron** → reinicio controlado con verificación (y últimos 20 logs si falla).

---

## 3. Rollback manual

Si una actualización sale mal:

```bash
# 1. (Recomendado) Asegura los datos antes de tocar nada
sudo cp -a /opt/taberna-mago/data /opt/taberna-mago-data.bak

# 2. Vuelve al commit/tag bueno
cd /opt/taberna-mago
sudo git log --oneline -10          # o: git tag
sudo git checkout <commit-o-tag-bueno>

# 3. Redespliega exactamente igual (detecta el modo rollback y omite git pull)
sudo bash scripts/deploy.sh

# 4. Si el problema afectaba a los datos, restaura la copia (con el servicio parado)
# sudo systemctl stop taberna-mago
# sudo rm -rf /opt/taberna-mago/data && sudo mv /opt/taberna-mago-data.bak /opt/taberna-mago/data
# sudo systemctl start taberna-mago
```

**Tip**: etiqueta los despliegues buenos (`git tag v1.0.0 && git push --tags`) para que el rollback sea trivial.

---

## 4. Comandos útiles

```bash
# Estado y control
sudo systemctl status taberna-mago       # ¿está vivo?
sudo systemctl restart taberna-mago      # reiniciar
sudo systemctl stop taberna-mago         # parar
sudo systemctl start taberna-mago        # arrancar
sudo systemctl enable taberna-mago       # arrancar al encender la Pi
sudo systemctl disable taberna-mago      # no arrancar al encender

# Logs (journald)
journalctl -u taberna-mago -f                    # seguir en directo
journalctl -u taberna-mago -n 100 --no-pager     # últimas 100 líneas
journalctl -u taberna-mago --since "1 hour ago"  # última hora
journalctl -u taberna-mago -p err                # solo errores

# Registrar/re-registrar comandos de Discord a mano
cd /opt/taberna-mago && sudo npm run deploy

# Editar configuración
sudo nano /opt/taberna-mago/.env && sudo systemctl restart taberna-mago
```

Logs sanos al arrancar:

```
🍺 La Taberna del Mago abre sus puertas: ...#5789 en línea.
📖 Comandos disponibles: /estrellitas, /estrellitas-negras, /inspiracion, /dm, /registros, /sincronizar
🦉 Escuchando canjes del canal de @tu-canal...   (si Twitch está sincronizado)
```

---

## 5. Qué NO hay que hacer

- ❌ `git clean -fdx` en el servidor → borraría `.env` y `data/` (ambos gitignored).
- ❌ Ejecutar el servicio como root (usa el usuario `orangepi` ya configurado).
- ❌ Abrir puertos en el firewall → no hace falta ninguno.
- ❌ `npm run build` → no existe: es JS directo, sin paso de build.

## 6. Archivos de esta infraestructura

| Archivo | Propósito |
|---|---|
| `scripts/install.sh` | Primera instalación (deja el servicio `enable --now`) |
| `scripts/deploy.sh` | Actualizaciones idempotentes con verificación y logs |
| `taberna-mago.service` | Unidad systemd (usuario `orangepi`, endurecida, solo `data/` escribible) |
| `.gitignore` | Mantiene secretos y datos fuera del repo |
| `README_DEPLOY.md` | Este documento |
