#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use std::net::IpAddr;
use tauri::State;
use url::Url;

const GM_TOKEN_TARGET: &str = "Griffin.GMTools.AdminToken";

#[tauri::command]
fn save_gm_token(token: String) -> Result<(), String> {
    if token.trim().len() < 24 {
        return Err("El token GM debe tener al menos 24 caracteres.".to_string());
    }
    credential_store::write(GM_TOKEN_TARGET, token.as_bytes())
}

#[tauri::command]
fn load_saved_gm_token() -> Result<Option<String>, String> {
    credential_store::read(GM_TOKEN_TARGET)?
        .map(|bytes| {
            String::from_utf8(bytes)
                .map_err(|_| "La credencial guardada no contiene texto válido.".to_string())
        })
        .transpose()
}

#[cfg(windows)]
mod credential_store {
    use std::{ffi::c_void, mem::zeroed, ptr};

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct CredentialW {
        flags: u32,
        kind: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: FileTime,
        credential_blob_size: u32,
        credential_blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut c_void,
        target_alias: *mut u16,
        user_name: *mut u16,
    }

    #[link(name = "Advapi32")]
    unsafe extern "system" {
        fn CredWriteW(credential: *const CredentialW, flags: u32) -> i32;
        fn CredReadW(
            target: *const u16,
            kind: u32,
            flags: u32,
            credential: *mut *mut CredentialW,
        ) -> i32;
        #[cfg(test)]
        fn CredDeleteW(target: *const u16, kind: u32, flags: u32) -> i32;
        fn CredFree(buffer: *mut c_void);
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    pub fn write(target: &str, secret: &[u8]) -> Result<(), String> {
        if secret.len() > 2560 {
            return Err(
                "El token supera el tamaño permitido por Windows Credential Manager.".into(),
            );
        }
        let target_name = wide(target);
        let user_name = wide("Griffin GM Tools");
        let credential = CredentialW {
            flags: 0,
            kind: 1,
            target_name: target_name.as_ptr() as *mut u16,
            comment: ptr::null_mut(),
            last_written: unsafe { zeroed() },
            credential_blob_size: secret.len() as u32,
            credential_blob: secret.as_ptr() as *mut u8,
            persist: 2,
            attribute_count: 0,
            attributes: ptr::null_mut(),
            target_alias: ptr::null_mut(),
            user_name: user_name.as_ptr() as *mut u16,
        };
        let ok = unsafe { CredWriteW(&credential, 0) };
        if ok == 0 {
            return Err(format!(
                "Windows no pudo guardar el token (código {}).",
                std::io::Error::last_os_error()
                    .raw_os_error()
                    .unwrap_or_default()
            ));
        }
        Ok(())
    }

    pub fn read(target: &str) -> Result<Option<Vec<u8>>, String> {
        let target_name = wide(target);
        let mut credential = ptr::null_mut();
        let ok = unsafe { CredReadW(target_name.as_ptr(), 1, 0, &mut credential) };
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(1168) {
                return Ok(None);
            }
            return Err(format!(
                "Windows no pudo leer la credencial guardada (código {}).",
                error.raw_os_error().unwrap_or_default()
            ));
        }
        let entry = unsafe { &*credential };
        let bytes = if entry.credential_blob_size == 0 || entry.credential_blob.is_null() {
            Vec::new()
        } else {
            unsafe {
                std::slice::from_raw_parts(
                    entry.credential_blob,
                    entry.credential_blob_size as usize,
                )
                .to_vec()
            }
        };
        unsafe {
            CredFree(credential.cast());
        }
        Ok(Some(bytes))
    }

    #[cfg(test)]
    pub fn delete_for_test(target: &str) {
        let target_name = wide(target);
        unsafe {
            CredDeleteW(target_name.as_ptr(), 1, 0);
        }
    }
}

#[cfg(not(windows))]
mod credential_store {
    pub fn write(_: &str, _: &[u8]) -> Result<(), String> {
        Err("El almacenamiento seguro solo está disponible en Windows.".into())
    }
    pub fn read(_: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }
}

struct GmHttp(Client);

#[tauri::command]
async fn gm_request(
    state: State<'_, GmHttp>,
    base_url: String,
    method: String,
    path: String,
    token: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if token.trim().len() < 24 {
        return Err("El token GM debe tener al menos 24 caracteres.".to_string());
    }

    let base =
        Url::parse(&base_url).map_err(|_| "La dirección del servidor no es válida.".to_string())?;
    if base.scheme() != "https"
        || base.username() != ""
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
        || !base.path().trim_matches('/').is_empty()
        || !is_loopback_ip(&base)
    {
        return Err(
            "Solo se permite HTTPS a una dirección IP loopback (127.0.0.1 o ::1).".to_string(),
        );
    }

    let method = match method.as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "DELETE" => Method::DELETE,
        _ => return Err("Método no permitido.".to_string()),
    };
    if !is_allowed_route(&method, &path) {
        return Err("La ruta no pertenece a las operaciones GM permitidas.".to_string());
    }

    let endpoint = base
        .join(&format!("api/gm/{path}"))
        .map_err(|_| "La ruta GM no es válida.".to_string())?;
    if endpoint.origin() != base.origin() {
        return Err("La ruta solicitada sale del servidor local.".to_string());
    }

    let mut request = state
        .0
        .request(method, endpoint)
        .header("X-GM-Token", token)
        .header("Accept", "application/json");
    if let Some(payload) = body {
        request = request.json(&payload);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("No se pudo contactar Griffin: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("No se pudo leer la respuesta de Griffin: {e}"))?;
    let value: Value = serde_json::from_str(&text)
        .unwrap_or_else(|_| json!({ "message": text, "httpStatus": status.as_u16() }));

    if !status.is_success() {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or_else(|| StatusCode::canonical_reason(&status).unwrap_or("Error de Griffin"));
        return Err(format!(
            "Griffin respondió {}: {}",
            status.as_u16(),
            message
        ));
    }
    Ok(value)
}

fn is_loopback_ip(url: &Url) -> bool {
    url.host_str()
        .map(|host| host.trim_start_matches('[').trim_end_matches(']'))
        .and_then(|host| host.parse::<IpAddr>().ok())
        .is_some_and(|ip| ip.is_loopback())
}

fn is_allowed_route(method: &Method, path: &str) -> bool {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.contains("..") {
        return false;
    }
    let (route, _) = path.split_once('?').unwrap_or((path, ""));
    let parts: Vec<&str> = route.split('/').collect();
    match (method, parts.as_slice()) {
        (&Method::GET, ["status"])
        | (&Method::GET, ["accounts"])
        | (&Method::GET, ["commands"])
        | (&Method::GET, ["catalog"]) => true,
        (&Method::GET, ["accounts", uid]) => uid.parse::<u32>().is_ok_and(|id| id > 0),
        (&Method::DELETE, ["accounts", uid]) => uid.parse::<u32>().is_ok_and(|id| id > 0),
        (&Method::POST, ["commands"]) => true,
        (&Method::POST, ["accounts", uid, operation]) => {
            uid.parse::<u32>().is_ok_and(|id| id > 0)
                && matches!(*operation, "items" | "characters" | "weapons" | "costumes" | "weapon-skins" | "clean")
        }
        (&Method::POST, ["accounts", uid, "inventory", "add-all"]) => {
            uid.parse::<u32>().is_ok_and(|id| id > 0)
        }
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = Client::builder()
        // TLS errors are ignored only for requests that the command has already
        // constrained to a numeric loopback IP and HTTPS.
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("could not create Griffin GM local HTTP client");

    tauri::Builder::default()
        .manage(GmHttp(http))
        .invoke_handler(tauri::generate_handler![
            gm_request,
            save_gm_token,
            load_saved_gm_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running Griffin GM Tools");
}

fn main() {
    run();
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_route, is_loopback_ip};
    use reqwest::Method;
    use url::Url;

    #[test]
    fn accepts_only_numeric_loopback_hosts() {
        assert!(is_loopback_ip(&Url::parse("https://127.0.0.1").unwrap()));
        assert!(is_loopback_ip(&Url::parse("https://[::1]").unwrap()));
        assert!(!is_loopback_ip(&Url::parse("https://localhost").unwrap()));
        assert!(!is_loopback_ip(
            &Url::parse("https://example.test").unwrap()
        ));
    }

    #[test]
    fn route_allowlist_covers_only_exposed_gm_operations() {
        assert!(is_allowed_route(&Method::GET, "status"));
        assert!(is_allowed_route(&Method::GET, "catalog"));
        assert!(is_allowed_route(&Method::GET, "accounts?q=123&limit=30"));
        assert!(is_allowed_route(&Method::GET, "accounts/123"));
        assert!(is_allowed_route(&Method::DELETE, "accounts/123"));
        assert!(is_allowed_route(&Method::POST, "accounts/123/items"));
        assert!(is_allowed_route(&Method::POST, "accounts/123/characters"));
        assert!(is_allowed_route(&Method::POST, "accounts/123/weapons"));
        assert!(is_allowed_route(&Method::POST, "accounts/123/costumes"));
        assert!(is_allowed_route(&Method::POST, "accounts/123/weapon-skins"));
        assert!(is_allowed_route(
            &Method::POST,
            "accounts/123/inventory/add-all"
        ));
        assert!(is_allowed_route(&Method::POST, "accounts/123/clean"));
        assert!(is_allowed_route(&Method::POST, "commands"));
        assert!(!is_allowed_route(&Method::GET, "accounts/abc"));
        assert!(!is_allowed_route(&Method::DELETE, "accounts/0"));
        assert!(!is_allowed_route(&Method::DELETE, "accounts/abc"));
        assert!(!is_allowed_route(&Method::DELETE, "accounts/123/items"));
        assert!(!is_allowed_route(&Method::POST, "accounts/123/ban"));
        assert!(!is_allowed_route(&Method::GET, "../status"));
        assert!(!is_allowed_route(&Method::GET, "accounts/123/items"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_credential_store_round_trips_and_cleans_up() {
        let target = format!("Griffin.GMTools.Test.{}", std::process::id());
        let secret = b"dummy-test-secret-never-a-real-token";
        super::credential_store::write(&target, secret).unwrap();
        assert_eq!(
            super::credential_store::read(&target).unwrap().as_deref(),
            Some(secret.as_slice())
        );
        super::credential_store::delete_for_test(&target);
        assert!(super::credential_store::read(&target).unwrap().is_none());
    }
}
