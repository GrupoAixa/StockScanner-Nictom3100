# Puesta en marcha — StockScanner en la nube

Pasos que tenés que hacer vos (requieren tu navegador / tus cuentas).
Cuando termines cada bloque, avisale a Claude para que siga con la parte
que le toca (llenar `docs/config.js`, correr la migración, publicar).

## 1. Crear el proyecto en Supabase

1. Entrá a https://supabase.com y creá una cuenta (podés usar "Continue with GitHub" con la cuenta GrupoAixa).
2. "New project" → elegí un nombre (ej: `stockscanner`), una contraseña de base de datos (guardala, no hace falta dármela) y una región cercana (ej: São Paulo).
3. Esperá a que el proyecto termine de aprovisionarse (1-2 minutos).

## 2. Copiar las claves del proyecto

En el dashboard: **Project Settings → API**.

- **Project URL** (ej: `https://abcabcabc.supabase.co`) → pasámela, es pública.
- **anon / public key** → pasámela, es pública (se usa en el navegador de todos).
- **service_role key** → **NO me la pegues en el chat**. Solo la vas a necesitar en el paso 6, como variable de entorno en tu propia PC.

## 3. Desactivar el registro público (importante — seguridad)

**Authentication → Providers → Email**:
- "Allow new users to sign up" → **OFF**
- "Confirm email" → **OFF** (los 3 usuarios se crean ya confirmados a mano, no tienen casilla de correo real)

Si dejás el registro abierto, cualquiera que entre a la página podría crearse una cuenta propia y acceder al stock — por eso este paso es obligatorio, no opcional.

## 4. Crear los 3 usuarios (Admin, Sergio, Leo)

**Authentication → Users → Add user → Create new user**, repetir 3 veces:

| Email | Contraseña |
|---|---|
| `admin@stockscanner.local` | la que elijas para Admin |
| `sergio@stockscanner.local` | la que elijas para Sergio |
| `leo@stockscanner.local` | la que elijas para Leo |

Tildá **"Auto Confirm User"** en cada uno (si no, quedan pendientes de confirmar por email, que no pueden recibir).

Guardá las 3 contraseñas en un lugar seguro (ej: gestor de contraseñas) — solo un administrador que entre a este mismo dashboard puede resetearlas después (ver sección 8).

## 5. Ejecutar el esquema de la base de datos

**SQL Editor → New query** → pegá todo el contenido de `supabase/schema.sql` de este repo → **Run**.

Esto crea las tablas `productos` y `movimientos`, activa Row Level Security, y habilita Realtime.

## 6. Migrar los datos actuales (`stockscanner.db`)

En tu PC, en la carpeta del proyecto:

```powershell
$env:SUPABASE_URL = "https://TU-PROYECTO.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "TU-SERVICE-ROLE-KEY"
python supabase\migrate_from_sqlite.py
```

El script solo usa la librería estándar de Python (no necesita `pip install` de nada). Al final te va a decir cuántos productos y movimientos quedaron en Supabase — tiene que coincidir con lo que tenías en `stockscanner.db`.

**Importante:** la `service_role key` que pusiste en `$env:SUPABASE_SERVICE_ROLE_KEY` solo queda en tu sesión de terminal — cerrá la terminal después si te preocupa que quede visible.

## 7. Publicar el sitio (GitHub Pages)

En GitHub: `github.com/GrupoAixa/StockScanner-Nictom3100` → **Settings → Pages**:
- Source: **Deploy from a branch**
- Branch: **main** (o `master`, según cuál use el repo) / carpeta **`/docs`**
- Guardar. GitHub tarda 1-2 minutos en publicar; la URL final va a ser algo como `https://grupoaixa.github.io/StockScanner-Nictom3100/`.

## 8. Si alguien olvida su contraseña

Solo quien tenga acceso al dashboard de Supabase puede resetearla:
**Authentication → Users → (click en el usuario) → Reset password** (te deja poner una nueva directamente, ya que no hay email real para el link de recuperación).

## 9. Si la app muestra un error de conexión después de mucho tiempo sin uso

El plan gratuito de Supabase **pausa el proyecto tras 7 días sin actividad** (no se pierden datos). Para reactivarlo: entrá a supabase.com → tu proyecto → botón **"Restore/Resume project"**. Tarda menos de un minuto.

## 10. Modo de emergencia sin internet

Si un día no hay conexión en el pañol, se puede seguir usando el `.exe` viejo (`dist/StockScanner.exe`, o `StockScanner.py`) como respaldo **temporal**. Reglas importantes:

- No usar el `.exe` y la web al mismo tiempo como si fueran la misma fuente de verdad — el `.exe` tiene su propia base local (`stockscanner.db`) que ya no se sincroniza con Supabase.
- Cuando vuelva la conexión, un encargado tiene que revisar los movimientos que se hicieron en el `.exe` durante el corte y cargarlos a mano en la web (o decidir cuál de las dos versiones de stock es la correcta).
- Este modo es solo para cortes puntuales, no para uso regular.
