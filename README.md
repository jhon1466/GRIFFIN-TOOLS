# Griffin GM Tools

Aplicación de escritorio (Windows) para administrar tu servidor privado [GRIFFIN](https://github.com/jhon1466/GRIFFIN) de **Girls' Frontline 2: Exilium**: buscar cuentas, entregar objetos, personajes, armas y skins, poner cantidades a cero y ejecutar comandos del servidor.

> Proyecto sin ánimo de lucro, hecho con fines educativos. No está afiliado a SunBorn. Las imágenes del catálogo proceden de wikis públicas de la comunidad (ver [Créditos](#créditos)).

## Qué hace

- **Entregar objeto**: busca por nombre, ID o código, con icono y nombre oficial en español, inglés o chino.
- **Personajes**: elige una doll, su nivel y, además, **una o varias skins** de ella en una galería con imágenes.
- **Armas**: elige el arma, las copias y las skins de esa arma que quieras desbloquear.
- **Poner cantidades a cero**: limpia objetos o recursos de una cuenta conservando los registros.
- Cuentas (consulta y borrado por UID), consola de comandos del servidor y registro de auditoría en el servidor.

Todo el catálogo (nombres, iconos, retratos de personajes y skins) va **empaquetado en la aplicación**.

## Uso

1. Descarga `Griffin-GM-Tools.exe` de [Releases](../../releases) (no necesita instalación).
2. Arranca el servidor GRIFFIN con un token de al menos 24 caracteres. En PowerShell, antes de `scripts\start-server.ps1`:
   ```powershell
   $env:GRIFFIN_GM_TOKEN = -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
   $env:GRIFFIN_GM_TOKEN   # cópialo
   ```
   (también puedes poner `GmAdmin:Token` en `Griffin/appsettings.json`).
3. Abre la aplicación, deja el servidor en `https://127.0.0.1`, pega el token y pulsa **Conectar**. El token se guarda en el Administrador de credenciales de Windows.

Seguridad: la API del servidor solo acepta HTTPS desde `127.0.0.1`/`::1` con el token, y la aplicación rechaza cualquier otra dirección.

Necesitas un servidor GRIFFIN reciente (con los endpoints `costumes` y `weapon-skins` y el arreglo para conceder personajes y armas con el jugador conectado).

## Compilar

Requisitos: [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) y WebView2 (incluido en Windows 10/11).

```powershell
npm install
npm run tauri:build      # genera src-tauri\target\release\griffin-gm-tools.exe
npm run dev              # solo la interfaz web, en http://127.0.0.1:4321
```

Estructura: `src/` (interfaz Astro + SolidJS + Tailwind), `src/data/gm-catalog.json` y `public/catalog/` (catálogo e imágenes), `src-tauri/` (envoltorio Tauri 2 en Rust: guarda el token en Windows y solo permite las rutas de la API GM).

## Créditos

- Retratos de personajes y skins de doll: [Wiki oficial de GF2](https://gf2-bbs.exiliumgf.com/wiki/category).
- Iconos de objetos y skins de armas: [IOPWiki](https://iopwiki.com/wiki/GFL2).
- Nombres oficiales de las tablas del juego y del paquete de idiomas del servidor.

Licencia MIT (ver `LICENSE`). Girls' Frontline 2: Exilium pertenece a sus propietarios.
