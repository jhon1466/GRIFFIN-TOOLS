//! Server manager: installs, runs and auto-updates a local Griffin server for people who do not
//! know how to build it. Everything lives in %LOCALAPPDATA%\GriffinServer:
//!
//!   server\current\        published server (from the GitHub release zip)
//!   server\previous\       last working version, restored if an update fails
//!   pgsql\                 portable PostgreSQL binaries (no installer, no Windows service)
//!   pgdata\                database cluster, port 5433, trust auth on loopback only
//!   patcher\               griffin_patcher.dll + griffin_launcher.exe
//!   backups\               pg_dump before every server update
//!   logs\                  server.log, postgres.log
//!   state.json             installed versions + settings
//!
//! Updates come from the "latest" GitHub release of REPO, described by its manifest.json
//! (written by .github/workflows/release.yml). Every download is checked against the SHA-256 in
//! the manifest before anything on disk is replaced.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager as _, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const REPO: &str = "jhon1466/GRIFFIN";
/// GM Tools itself is released from its own repository.
pub const TOOLS_REPO: &str = "jhon1466/GRIFFIN-TOOLS";
pub const APP_VERSION: &str = match option_env!("GRIFFIN_BUILD_VERSION") {
    Some(v) => v,
    None => "dev",
};
const PG_PORT: u16 = 5433;
const PG_VERSION: &str = "16.4.0";
const SERVER_PORTS: [u16; 3] = [80, 443, 7001];
const SERVER_ZIP: &str = "griffin-server-win-x64.zip";
const PATCHER_ZIP: &str = "griffin-patcher-win-x64.zip";
const APP_EXE: &str = "Griffin-GM-Tools.exe";

// ----------------------------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub server_version: Option<String>,
    pub patcher_version: Option<String>,
    pub game_dir: Option<String>,
    #[serde(default = "yes")]
    pub auto_update: bool,
    /// Address the game client is told to connect to (GameServer:Host). 127.0.0.1 = this PC only.
    #[serde(default = "loopback")]
    pub public_host: String,
}
fn yes() -> bool {
    true
}
fn loopback() -> String {
    "127.0.0.1".into()
}

#[derive(Default)]
pub struct Manager {
    server: Mutex<Option<Child>>,
    busy: Mutex<bool>,
}

#[derive(Deserialize, Clone)]
struct AssetInfo {
    sha256: String,
}

#[derive(Deserialize, Clone)]
struct Manifest {
    version: String,
    assets: HashMap<String, AssetInfo>,
}

struct Release {
    manifest: Manifest,
    urls: HashMap<String, String>,
}

fn base_dir() -> PathBuf {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    root.join("GriffinServer")
}
fn p(rel: &str) -> PathBuf {
    base_dir().join(rel)
}

fn load_settings() -> Settings {
    fs::read_to_string(p("state.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Settings {
            auto_update: true,
            public_host: loopback(),
            ..Default::default()
        })
}
fn save_settings(s: &Settings) -> Result<(), String> {
    fs::create_dir_all(base_dir()).map_err(e)?;
    fs::write(p("state.json"), serde_json::to_vec_pretty(s).map_err(e)?).map_err(e)
}
fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

fn progress(app: &AppHandle, stage: &str, pct: f64, message: impl Into<String>) {
    let _ = app.emit(
        "manager-progress",
        serde_json::json!({ "stage": stage, "pct": pct, "message": message.into() }),
    );
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

// ----------------------------------------------------------------------------------------------
// GitHub release + verified downloads
// ----------------------------------------------------------------------------------------------

fn http() -> Client {
    Client::builder()
        .user_agent(format!("Griffin-GM-Tools/{APP_VERSION}"))
        .build()
        .expect("http client")
}

async fn latest_release() -> Result<Release, String> {
    let client = http();
    let rel: serde_json::Value = client
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|x| format!("No se pudo consultar GitHub: {x}"))?
        .error_for_status()
        .map_err(|x| format!("GitHub respondió con error (¿todavía no hay releases?): {x}"))?
        .json()
        .await
        .map_err(e)?;
    let mut urls = HashMap::new();
    for a in rel["assets"].as_array().cloned().unwrap_or_default() {
        if let (Some(n), Some(u)) = (a["name"].as_str(), a["browser_download_url"].as_str()) {
            urls.insert(n.to_string(), u.to_string());
        }
    }
    let murl = urls
        .get("manifest.json")
        .ok_or("La última release no tiene manifest.json.")?;
    let manifest: Manifest = client
        .get(murl)
        .send()
        .await
        .map_err(e)?
        .error_for_status()
        .map_err(e)?
        .json()
        .await
        .map_err(|x| format!("manifest.json inválido: {x}"))?;
    Ok(Release { manifest, urls })
}

async fn download(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    sha256: Option<&str>,
    label: &str,
) -> Result<(), String> {
    let mut resp = http()
        .get(url)
        .send()
        .await
        .map_err(|x| format!("Descarga fallida ({label}): {x}"))?
        .error_for_status()
        .map_err(|x| format!("Descarga fallida ({label}): {x}"))?;
    let total = resp.content_length().unwrap_or(0) as f64;
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(e)?;
    }
    let tmp = dest.with_extension("part");
    let mut file = fs::File::create(&tmp).map_err(e)?;
    let mut hasher = Sha256::new();
    let mut done = 0f64;
    let mut last = 0f64;
    while let Some(chunk) = resp.chunk().await.map_err(e)? {
        file.write_all(&chunk).map_err(e)?;
        hasher.update(&chunk);
        done += chunk.len() as f64;
        if total > 0.0 && done / total - last >= 0.01 {
            last = done / total;
            progress(app, "download", last * 100.0, format!("Descargando {label}…"));
        }
    }
    drop(file);
    if let Some(expected) = sha256 {
        let got = format!("{:x}", hasher.finalize());
        if !got.eq_ignore_ascii_case(expected) {
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "{label}: el archivo descargado no coincide con el SHA-256 publicado. No se instaló nada."
            ));
        }
    }
    fs::rename(&tmp, dest).map_err(e)
}

fn unzip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let f = fs::File::open(zip_path).map_err(e)?;
    let mut z = zip::ZipArchive::new(f).map_err(e)?;
    z.extract(dest).map_err(e)
}

// ----------------------------------------------------------------------------------------------
// PostgreSQL (portable)
// ----------------------------------------------------------------------------------------------

fn pg_bin(name: &str) -> PathBuf {
    p("pgsql").join("bin").join(format!("{name}.exe"))
}

async fn ensure_postgres_binaries(app: &AppHandle) -> Result<(), String> {
    if pg_bin("pg_ctl").exists() {
        return Ok(());
    }
    // Zonky publishes the official EnterpriseDB Windows binaries trimmed to what an embedded
    // server needs (~30 MB) as a .txz inside a jar on Maven Central.
    let url = format!(
        "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/{v}/embedded-postgres-binaries-windows-amd64-{v}.jar",
        v = PG_VERSION
    );
    let jar = p("downloads").join("postgres.jar");
    download(app, &url, &jar, None, "PostgreSQL").await?;
    progress(app, "postgres", 0.0, "Extrayendo PostgreSQL…");
    let f = fs::File::open(&jar).map_err(e)?;
    let mut z = zip::ZipArchive::new(f).map_err(e)?;
    let name = (0..z.len())
        .filter_map(|i| z.by_index(i).ok().map(|f| f.name().to_string()))
        .find(|n| n.ends_with(".txz"))
        .ok_or("El paquete de PostgreSQL no contiene binarios.")?;
    let mut txz = Vec::new();
    z.by_name(&name).map_err(e)?.read_to_end(&mut txz).map_err(e)?;
    let mut tar_bytes = Vec::new();
    lzma_rs::xz_decompress(&mut std::io::Cursor::new(txz), &mut tar_bytes).map_err(e)?;
    let target = p("pgsql");
    let _ = fs::remove_dir_all(&target);
    tar::Archive::new(std::io::Cursor::new(tar_bytes))
        .unpack(&target)
        .map_err(e)?;
    let _ = fs::remove_file(&jar);
    if !pg_bin("pg_ctl").exists() {
        return Err("PostgreSQL se extrajo pero falta pg_ctl.exe.".into());
    }
    Ok(())
}

fn pg_running() -> bool {
    pg_bin("pg_ctl").exists()
        && hidden(Command::new(pg_bin("pg_ctl")).args(["status", "-D"]).arg(p("pgdata")))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
}

async fn ensure_postgres(app: &AppHandle) -> Result<(), String> {
    ensure_postgres_binaries(app).await?;
    fs::create_dir_all(p("logs")).map_err(e)?;
    if !p("pgdata").join("PG_VERSION").exists() {
        progress(app, "postgres", 50.0, "Creando la base de datos…");
        let out = hidden(Command::new(pg_bin("initdb")).args([
            "-U", "postgres", "-A", "trust", "-E", "UTF8", "--locale=C", "-D",
        ]))
        .arg(p("pgdata"))
        .output()
        .map_err(e)?;
        if !out.status.success() {
            return Err(format!(
                "initdb falló: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    if !pg_running() {
        progress(app, "postgres", 80.0, "Iniciando PostgreSQL…");
        let out = hidden(Command::new(pg_bin("pg_ctl")).args(["start", "-w", "-D"]))
            .arg(p("pgdata"))
            .arg("-o")
            .arg(format!("-p {PG_PORT} -c listen_addresses=127.0.0.1"))
            .arg("-l")
            .arg(p("logs").join("postgres.log"))
            // pg_ctl leaves postgres.exe holding inherited stdout/stderr: never capture them,
            // or this call would wait forever for the pipes to close.
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(e)?;
        if !out.success() {
            return Err(format!(
                "PostgreSQL no arrancó. Revisa {}",
                p("logs").join("postgres.log").display()
            ));
        }
    }
    Ok(())
}

fn stop_postgres() {
    if pg_running() {
        let _ = hidden(Command::new(pg_bin("pg_ctl")).args(["stop", "-m", "fast", "-D"]))
            .arg(p("pgdata"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// File-level backup of the whole cluster (the portable binaries ship without pg_dump).
/// PostgreSQL is stopped while copying so the copy is consistent; keeps the last 5 backups.
fn backup_database() -> Result<Option<PathBuf>, String> {
    let data = p("pgdata");
    if !data.join("PG_VERSION").exists() {
        return Ok(None);
    }
    // Stopped here; start_server_inner brings it back with the server.
    stop_postgres();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = p("backups").join(format!("pgdata-{ts}"));
    copy_dir(&data, &dest).map_err(|x| format!("No se pudo respaldar la base de datos: {x}"))?;
    let mut olds: Vec<PathBuf> = fs::read_dir(p("backups"))
        .map(|r| r.filter_map(|x| x.ok().map(|x| x.path())).collect())
        .unwrap_or_default();
    olds.sort();
    while olds.len() > 5 {
        let _ = fs::remove_dir_all(olds.remove(0));
    }
    Ok(Some(dest))
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

// ----------------------------------------------------------------------------------------------
// Server process
// ----------------------------------------------------------------------------------------------

fn port_busy(port: u16) -> bool {
    TcpListener::bind(("0.0.0.0", port)).is_err()
}

fn gm_token() -> Result<String, String> {
    if let Some(t) = crate::credential_store::read(crate::GM_TOKEN_TARGET)? {
        if let Ok(s) = String::from_utf8(t) {
            if s.len() >= 24 {
                return Ok(s);
            }
        }
    }
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).map_err(e)?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    crate::credential_store::write(crate::GM_TOKEN_TARGET, token.as_bytes())?;
    Ok(token)
}

fn server_running(m: &Manager) -> bool {
    let mut guard = m.server.lock().unwrap();
    match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            _ => {
                *guard = None;
                false
            }
        },
        None => false,
    }
}

async fn start_server_inner(app: &AppHandle, m: &Manager) -> Result<(), String> {
    if server_running(m) {
        return Ok(());
    }
    let exe = p("server").join("current").join("Griffin.exe");
    if !exe.exists() {
        return Err("El servidor no está instalado todavía.".into());
    }
    let busy: Vec<String> = SERVER_PORTS
        .iter()
        .filter(|port| port_busy(**port))
        .map(|port| port.to_string())
        .collect();
    if !busy.is_empty() {
        return Err(format!(
            "Otro programa está usando el/los puerto(s) {}. Ciérralo (Skype, IIS, otro servidor…) y vuelve a intentar.",
            busy.join(", ")
        ));
    }
    ensure_postgres(app).await?;
    let settings = load_settings();
    let token = gm_token()?;
    fs::create_dir_all(p("logs")).map_err(e)?;
    let log = fs::File::create(p("logs").join("server.log")).map_err(e)?;
    let child = hidden(
        Command::new(&exe)
            .current_dir(exe.parent().unwrap())
            .env(
                "ConnectionStrings__Postgres",
                format!("Host=127.0.0.1;Port={PG_PORT};Database=griffin;Username=postgres;Password=postgres"),
            )
            .env("GameServer__Host", &settings.public_host)
            .env("GRIFFIN_GM_TOKEN", token)
            .stdout(log.try_clone().map_err(e)?)
            .stderr(log)
            .stdin(Stdio::null()),
    )
    .spawn()
    .map_err(|x| format!("No se pudo iniciar Griffin.exe: {x}"))?;
    *m.server.lock().unwrap() = Some(child);
    progress(app, "server", 100.0, "Servidor iniciado.");
    Ok(())
}

fn stop_server_inner(m: &Manager) {
    if let Some(mut child) = m.server.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ----------------------------------------------------------------------------------------------
// Install / update
// ----------------------------------------------------------------------------------------------

async fn install_server(app: &AppHandle, m: &Manager, rel: &Release) -> Result<bool, String> {
    let mut settings = load_settings();
    let v = &rel.manifest.version;
    if settings.server_version.as_deref() == Some(v.as_str())
        && p("server").join("current").join("Griffin.exe").exists()
    {
        return Ok(false);
    }
    let asset = rel.manifest.assets.get(SERVER_ZIP).ok_or("Falta el servidor en la release.")?;
    let url = rel.urls.get(SERVER_ZIP).ok_or("Falta el servidor en la release.")?;
    let zip = p("downloads").join(SERVER_ZIP);
    download(app, url, &zip, Some(&asset.sha256), "servidor").await?;

    let staging = p("server").join("staging");
    let _ = fs::remove_dir_all(&staging);
    unzip(&zip, &staging)?;
    if !staging.join("Griffin.exe").exists() {
        return Err("El paquete del servidor no contiene Griffin.exe. No se cambió nada.".into());
    }

    let was_running = server_running(m);
    stop_server_inner(m);
    progress(app, "update", 0.0, "Respaldando la base de datos…");
    backup_database()?;

    let current = p("server").join("current");
    let previous = p("server").join("previous");
    // Keep the server's own logs across versions.
    let old_logs = current.join("logs");
    let _ = fs::remove_dir_all(&previous);
    if current.exists() {
        fs::rename(&current, &previous).map_err(e)?;
    }
    if let Err(err) = fs::rename(&staging, &current) {
        if previous.exists() {
            let _ = fs::rename(&previous, &current);
        }
        return Err(format!("No se pudo instalar la nueva versión ({err}); se restauró la anterior."));
    }
    let prev_logs = previous.join("logs");
    if prev_logs.exists() && !old_logs.exists() {
        let _ = fs::rename(&prev_logs, current.join("logs"));
    }
    let _ = fs::remove_file(&zip);
    settings.server_version = Some(v.clone());
    save_settings(&settings)?;

    if was_running {
        if let Err(err) = start_server_inner(app, m).await {
            // New version does not start: roll back to the previous one.
            stop_server_inner(m);
            let _ = fs::remove_dir_all(&current);
            if previous.exists() {
                let _ = fs::rename(&previous, &current);
            }
            settings.server_version = None;
            let _ = save_settings(&settings);
            let _ = start_server_inner(app, m).await;
            return Err(format!("La versión {v} no arrancó ({err}); se volvió a la anterior."));
        }
    }
    Ok(true)
}

async fn install_patcher_files(app: &AppHandle, rel: &Release) -> Result<bool, String> {
    let mut settings = load_settings();
    let v = &rel.manifest.version;
    if settings.patcher_version.as_deref() == Some(v.as_str()) && p("patcher").join("griffin_launcher.exe").exists() {
        return Ok(false);
    }
    let asset = rel.manifest.assets.get(PATCHER_ZIP).ok_or("Falta el patcher en la release.")?;
    let url = rel.urls.get(PATCHER_ZIP).ok_or("Falta el patcher en la release.")?;
    let zip = p("downloads").join(PATCHER_ZIP);
    download(app, url, &zip, Some(&asset.sha256), "parche del juego").await?;
    let _ = fs::remove_dir_all(p("patcher"));
    unzip(&zip, &p("patcher"))?;
    let _ = fs::remove_file(&zip);
    settings.patcher_version = Some(v.clone());
    save_settings(&settings)?;
    // Copy into the game folder too when we already know it (needs admin for Program Files).
    if let Some(dir) = settings.game_dir.clone() {
        let _ = copy_patcher_to_game(&dir);
    }
    Ok(true)
}

/// Copies the patcher into the game folder through an elevated PowerShell (one UAC prompt),
/// keeping the old daiyan.dll / launcher.exe as .old like scripts/install-griffin-patcher.ps1.
fn copy_patcher_to_game(game_dir: &str) -> Result<(), String> {
    let game = Path::new(game_dir);
    if !game.join("GF2_Exilium.exe").exists() {
        return Err("En esa carpeta no está GF2_Exilium.exe.".into());
    }
    let src = p("patcher");
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         Copy-Item -LiteralPath '{s}\\griffin_patcher.dll','{s}\\griffin_launcher.exe' -Destination '{g}' -Force; \
         foreach ($o in 'daiyan.dll','launcher.exe') {{ $f = Join-Path '{g}' $o; if (Test-Path $f) {{ Move-Item $f \"$f.old\" -Force }} }}",
        s = src.display().to_string().replace('\'', "''"),
        g = game_dir.replace('\'', "''")
    );
    let status = hidden(Command::new("powershell").args([
        "-NoProfile",
        "-Command",
        &format!(
            "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',\"{}\"",
            script.replace('"', "`\"")
        ),
    ]))
    .status()
    .map_err(e)?;
    if !status.success() || !game.join("griffin_launcher.exe").exists() {
        return Err("No se copió el parche (¿se canceló el permiso de administrador?).".into());
    }
    Ok(())
}

fn version_key(v: &str) -> Vec<u64> {
    v.trim_start_matches('v')
        .split(|c: char| !c.is_ascii_digit())
        .filter(|x| !x.is_empty())
        .map(|x| x.parse().unwrap_or(0))
        .collect()
}

/// Replaces the running GM Tools exe with the newest GRIFFIN-TOOLS release and relaunches it.
/// Local builds report "dev" and never replace themselves.
async fn self_update(app: &AppHandle) -> Result<bool, String> {
    if APP_VERSION == "dev" {
        return Ok(false);
    }
    let client = http();
    let rel: serde_json::Value = client
        .get(format!("https://api.github.com/repos/{TOOLS_REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(e)?
        .error_for_status()
        .map_err(e)?
        .json()
        .await
        .map_err(e)?;
    let tag = rel["tag_name"].as_str().unwrap_or_default().to_string();
    if version_key(&tag) <= version_key(APP_VERSION) {
        return Ok(false);
    }
    let url_of = |name: &str| {
        rel["assets"].as_array().and_then(|a| {
            a.iter()
                .find(|x| x["name"] == name)
                .and_then(|x| x["browser_download_url"].as_str().map(String::from))
        })
    };
    let (Some(exe_url), Some(sum_url)) = (url_of(APP_EXE), url_of(&format!("{APP_EXE}.sha256"))) else {
        return Ok(false);
    };
    let sum_text = client.get(sum_url).send().await.map_err(e)?.text().await.map_err(e)?;
    let sha = sum_text.split_whitespace().next().unwrap_or_default().to_string();
    if sha.len() != 64 {
        return Err("El .sha256 de GM Tools no es válido.".into());
    }
    let exe = std::env::current_exe().map_err(e)?;
    let new = exe.with_extension("new");
    download(app, &exe_url, &new, Some(&sha), &format!("GM Tools {tag}")).await?;
    let old = exe.with_extension("old");
    let _ = fs::remove_file(&old);
    fs::rename(&exe, &old).map_err(e)?; // allowed while running on Windows
    if let Err(err) = fs::rename(&new, &exe) {
        let _ = fs::rename(&old, &exe);
        return Err(e(err));
    }
    progress(app, "done", 100.0, format!("GM Tools actualizado a {tag}; reiniciando…"));
    let _ = Command::new(&exe).spawn();
    app.exit(0);
    Ok(true)
}

pub async fn update_all(app: &AppHandle, m: &Manager) -> Result<String, String> {
    {
        let mut b = m.busy.lock().unwrap();
        if *b {
            return Err("Ya hay una instalación en curso.".into());
        }
        *b = true;
    }
    let result = async {
        progress(app, "check", 0.0, "Buscando actualizaciones…");
        let rel = latest_release().await?;
        let server = install_server(app, m, &rel).await?;
        let patcher = install_patcher_files(app, &rel).await?;
        ensure_postgres_binaries(app).await?;
        let v = rel.manifest.version.clone();
        // Last: this may restart the app.
        self_update(app).await?;
        Ok::<String, String>(if server || patcher {
            format!("Actualizado a la versión {v}.")
        } else {
            format!("Ya tienes la última versión ({v}).")
        })
    }
    .await;
    *m.busy.lock().unwrap() = false;
    match &result {
        Ok(msg) => progress(app, "done", 100.0, msg.clone()),
        Err(err) => progress(app, "error", 0.0, err.clone()),
    }
    result
}

/// Background loop: check at startup and every 30 minutes; install by itself when enabled.
pub fn spawn_auto_updater(app: AppHandle) {
    let old = std::env::current_exe().map(|x| x.with_extension("old"));
    if let Ok(old) = old {
        let _ = fs::remove_file(old);
    }
    tauri::async_runtime::spawn(async move {
        loop {
            if load_settings().auto_update {
                let m = app.state::<Manager>();
                let _ = update_all(&app, &m).await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(30 * 60)).await;
        }
    });
}

pub fn shutdown(m: &Manager) {
    stop_server_inner(m);
    stop_postgres();
}

// ----------------------------------------------------------------------------------------------
// Tauri commands
// ----------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    app_version: String,
    settings: Settings,
    installed: bool,
    server_running: bool,
    postgres_running: bool,
    busy_ports: Vec<u16>,
    data_dir: String,
    patcher_in_game: bool,
}

#[tauri::command]
pub fn manager_status(m: State<'_, Manager>) -> Status {
    let settings = load_settings();
    let running = server_running(&m);
    let patcher_in_game = settings
        .game_dir
        .as_deref()
        .is_some_and(|d| Path::new(d).join("griffin_launcher.exe").exists());
    Status {
        app_version: APP_VERSION.into(),
        installed: p("server").join("current").join("Griffin.exe").exists(),
        server_running: running,
        postgres_running: pg_running(),
        busy_ports: if running {
            vec![]
        } else {
            SERVER_PORTS.iter().copied().filter(|x| port_busy(*x)).collect()
        },
        data_dir: base_dir().display().to_string(),
        patcher_in_game,
        settings,
    }
}

#[tauri::command]
pub async fn manager_update(app: AppHandle, m: State<'_, Manager>) -> Result<String, String> {
    update_all(&app, &m).await
}

#[tauri::command]
pub async fn manager_start(app: AppHandle, m: State<'_, Manager>) -> Result<(), String> {
    if !p("server").join("current").join("Griffin.exe").exists() {
        update_all(&app, &m).await?;
    }
    start_server_inner(&app, &m).await
}

#[tauri::command]
pub fn manager_stop(m: State<'_, Manager>) {
    shutdown(&m);
}

#[tauri::command]
pub fn manager_set_settings(auto_update: bool, public_host: String) -> Result<(), String> {
    let mut s = load_settings();
    s.auto_update = auto_update;
    let host = public_host.trim();
    s.public_host = if host.is_empty() { loopback() } else { host.to_string() };
    save_settings(&s)
}

#[tauri::command]
pub fn manager_set_game_dir(game_dir: String) -> Result<(), String> {
    let dir = game_dir.trim().trim_matches('"').to_string();
    if !Path::new(&dir).join("GF2_Exilium.exe").exists() {
        return Err("En esa carpeta no está GF2_Exilium.exe.".into());
    }
    let mut s = load_settings();
    s.game_dir = Some(dir.clone());
    save_settings(&s)?;
    if p("patcher").join("griffin_launcher.exe").exists() {
        copy_patcher_to_game(&dir)?;
    }
    Ok(())
}

#[tauri::command]
pub fn manager_play() -> Result<(), String> {
    let s = load_settings();
    let dir = s.game_dir.ok_or("Primero elige la carpeta del juego.")?;
    let launcher = Path::new(&dir).join("griffin_launcher.exe");
    if !launcher.exists() {
        return Err("El parche no está en la carpeta del juego. Pulsa «Instalar parche».".into());
    }
    // griffin_launcher.exe must run as administrator.
    let status = hidden(Command::new("powershell").args([
        "-NoProfile",
        "-Command",
        &format!(
            "Start-Process -FilePath '{}' -WorkingDirectory '{}' -Verb RunAs",
            launcher.display().to_string().replace('\'', "''"),
            dir.replace('\'', "''")
        ),
    ]))
    .status()
    .map_err(e)?;
    if status.success() {
        Ok(())
    } else {
        Err("No se pudo abrir el juego (¿se canceló el permiso de administrador?).".into())
    }
}

#[tauri::command]
pub fn manager_log_tail(lines: Option<usize>) -> String {
    let text = fs::read_to_string(p("logs").join("server.log")).unwrap_or_default();
    let n = lines.unwrap_or(200);
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(n)..].join("\n")
}

#[tauri::command]
pub fn manager_open_folder() {
    let _ = Command::new("explorer").arg(base_dir()).spawn();
}

#[tauri::command]
pub fn manager_saved_token() -> Result<Option<String>, String> {
    crate::credential_store::read(crate::GM_TOKEN_TARGET)?
        .map(|b| String::from_utf8(b).map_err(e))
        .transpose()
}
