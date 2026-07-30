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

### Sincronizar Twitch con tu túnel de Cloudflare (opcional)

El bot no necesita puertos abiertos: tu túnel de Cloudflare ya expone el callback. Configura en `/opt/taberna-mago/.env`:

```bash
TWITCH_CALLBACK_URL=https://owltwitch.cobaltcatstudios.com/callback
TWITCH_AUTH_PORT=3050   # el puerto local al que apunta tu túnel
```

1. En https://dev.twitch.tv/console/apps → tu app → registra la URL pública como *OAuth Redirect URL* (una sola vez).
2. El DM (o un admin) ejecuta `/sincronizar twitch` en Discord, abre el enlace y autoriza con la cuenta del canal.
3. Twitch redirige a tu dominio → Cloudflare lo reenvía a `localhost:3050` del servidor → listo, el bot confirma al instante.

Los tokens quedan en `/opt/taberna-mago/data/twitch-token.json` y **se renuevan solos** cada ~3.5 h. Sin túnel (misma máquina), deja `TWITCH_CALLBACK_URL` vacía y se usará `http://localhost:3050/callback`.

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

---

## 7. Deploy desde Windows

`deploy-taberna.bat` ejecuta `scripts/deploy.sh` **en la Pi por SSH** desde tu PC, sin abrir nada más. Es un script *local* (está en `.gitignore`: cada PC puede tener el suyo con otra IP).

### Preparación (una sola vez)

**1. Verifica que tienes OpenSSH** (viene con Windows 11):

```powershell
ssh -V
```

Si dice que no existe: *Configuración → Aplicaciones → Características opcionales → Agregar una característica → OpenSSH Client*, o en PowerShell de administrador:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
```

**2. Guarda el script en una carpeta propia:**

```powershell
mkdir "$env:USERPROFILE\Scripts"
copy deploy-taberna.bat "$env:USERPROFILE\Scripts\"
```

**3. Añade esa carpeta al PATH** (para ejecutarlo desde cualquier sitio):

```powershell
$p = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$p;$env:USERPROFILE\Scripts", "User")
```

*(También puedes hacerlo por interfaz: busca "Editar las variables de entorno" → Variables de entorno → `Path` de usuario → Editar → Nuevo → `%USERPROFILE%\Scripts`.)*
**Cierra y abre la terminal** para que coja el nuevo PATH.

### Uso diario

Desde PowerShell o CMD, en **cualquier carpeta**:

```
deploy-taberna
```

Salida esperada: `Deploying Taberna del Mago...` → te pedirá la contraseña de `sudo` de la Pi → logs del deploy → `Deploy completed.` Si algo falla: `Deploy failed.` y la ventana se queda abierta con los últimos logs de la Pi.

### Notas

- La **primera vez** SSH te pedirá aceptar la huella del host (`yes`) y luego la contraseña (o tu clave, si tienes `ssh-copy-id` ya hecho a la Pi).
- Devuelve `ERRORLEVEL` 0/1, útil si lo encadenas con otros scripts.
- Si el deploy remoto muestra `dubious ownership in repository`, ejecuta **una vez** en la Pi:
  `sudo git config --global --add safe.directory /opt/taberna-mago`
  (los `install.sh`/`deploy.sh` actuales ya lo hacen automáticamente).

---

## 8. Música Djinni (Owlbear → llamada de Discord)

El bot puede sonar en el canal de voz lo que el DM ponga en Djinni (YouTube), además de `/musica` manual. **Dependencias del SISTEMA en la Pi (RISC-V: se instalan por apt, de npm nada):**

```bash
sudo apt update && sudo apt install -y ffmpeg yt-dlp
```

**Pasos de puesta en marcha (una sola vez):**

**1. `.env` de la Pi** (`/opt/taberna-mago/.env`) — añade el bloque (mismo puerto que OAuth, mismo túnel):

```bash
DJINNI_PORT=3050
DJINNI_SLUG=<el-mismo-slug-largo-generado-en-tu-.env-del-pc>
DJINNI_PUBLIC_URL=https://owltwitch.cobaltcatstudios.com
```

**2. Túnel de Cloudflare**: ya tienes `owltwitch.cobaltcatstudios.com → localhost:3050` (el mismo que usa el callback OAuth de Twitch). No hace falta otro subdominio.

**3. Compila el fork de Djinni** (en tu PC — CRA en la Pi va lento):

```powershell
cd src\djinni
npm ci
# Edita src\discordSync.jsx: BRIDGE_URL = "https://owltwitch.cobaltcatstudios.com" y BRIDGE_SLUG = DJINNI_SLUG
npm run build
# Sube el build a la Pi:
scp -r build orangepi@192.168.68.110:/tmp/djinni-build
ssh orangepi@192.168.68.110 "sudo rm -rf /opt/taberna-mago/src/djinni/build && sudo mv /tmp/djinni-build /opt/taberna-mago/src/djinni/build && sudo chown -R orangepi:orangepi /opt/taberna-mago/src/djinni/build"
```

**4. En Owlbear Rodeo**: perfil → Extensions → añade `https://owltwitch.cobaltcatstudios.com/manifest.json`.

**Uso por sesión:**

```
/syncmusic unir      → el bot se conecta al canal donde esté el DM
DM usa Djinni normal → suena en la llamada (cambios de pista, pausa, volúmenes)
/musica url <youtube>[loop][volumen]   → pinchar algo sin Owlbear
/syncmusic parar     → silencio y desconexión (si el canal se queda vacío, se retira solo a los 5 min)
```

**Notas de diseño (v1):** fuentes = lo que entienda yt-dlp (YouTube incluido); un canal de voz por servidor (limitación de Discord); loops "aleatorios" de Djinni se aproximan con retardo aleatorio equivalente; fades personalizados y seek-sync fino quedan para v2; el endpoint usa slug+rate limit+dedup (apto para túnel público del grupo privado). Health check: `curl https://owltwitch.cobaltcatstudios.com/health`.
