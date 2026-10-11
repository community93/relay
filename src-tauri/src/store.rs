use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, RwLock};

static DATA_DIR: OnceLock<RwLock<PathBuf>> = OnceLock::new();
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn locator_paths() -> Vec<PathBuf> {
    if let Ok(path) = std::env::var("RELAY_DATA") {
        return vec![PathBuf::from(path).join(".relay-location.json")];
    }
    let mut paths = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() { paths.push(parent.join("relay-location.json")); }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        paths.push(PathBuf::from(local).join("Relay").join("relay-location.json"));
    }
    paths
}

const ALLOWED_DOMAINS: &[&str] = &[
    "collections",
    "environments",
    "docs",
    "history",
    "settings",
    "tabs",
    "workspace",
    "runners",
    "runs",
];

fn is_safe_domain(domain: &str) -> bool {
    ALLOWED_DOMAINS.contains(&domain)
}

fn choose_dir() -> PathBuf {
    for locator in locator_paths() {
        if let Ok(text) = fs::read_to_string(locator) {
            if let Ok(path) = serde_json::from_str::<PathBuf>(&text) {
                if path.is_absolute() && writable(&path) { return path; }
            }
        }
    }
    if let Ok(from_env) = std::env::var("RELAY_DATA") {
        let p = PathBuf::from(from_env);
        if writable(&p) {
            return p;
        }
    }
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data");
        if writable(&dev) {
            return dev;
        }
    }
    // Portable first: a `data` folder next to the exe travels with it.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join("data");
            if writable(&candidate) {
                return candidate;
            }
        }
    }
    let mut fallback = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    fallback.push("Relay");
    fallback.push("data");
    let _ = writable(&fallback);
    fallback
}

fn writable(dir: &PathBuf) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(format!(".write-test-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
    if fs::OpenOptions::new().write(true).create_new(true).open(&probe).is_err() {
        return false;
    }
    let _ = fs::remove_file(&probe);
    true
}

pub fn data_dir() -> PathBuf {
    DATA_DIR.get_or_init(|| RwLock::new(choose_dir())).read().unwrap_or_else(|p| p.into_inner()).clone()
}

fn file_for(domain: &str) -> Result<PathBuf, String> {
    if !is_safe_domain(domain) {
        return Err(format!("未知的数据域: {domain}"));
    }
    Ok(data_dir().join(format!("{domain}.json")))
}

/// Returns the stored JSON text, or "null" when nothing was saved yet.
pub fn read_doc(domain: &str) -> Result<String, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = file_for(domain)?;
    match fs::read_to_string(&path) {
        Ok(text) if text.trim().is_empty() => Ok("null".into()),
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("null".into()),
        Err(e) => Err(format!("读取 {} 失败: {e}", path.display())),
    }
}

/// Writes through a temp file so a crash can never leave a half-saved document.
pub fn write_doc(domain: &str, content: &str) -> Result<String, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = file_for(domain)?;
    if serde_json::from_str::<serde_json::Value>(content).is_err() {
        return Err("内容不是合法 JSON，已拒绝写入".into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    if fs::rename(&tmp, &path).is_err() {
        // A previous run may hold the target open; retry once after a short pause.
        std::thread::sleep(std::time::Duration::from_millis(120));
        fs::rename(&tmp, &path).map_err(|e| format!("保存失败: {e}"))?;
    }
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn load_doc(domain: String) -> Result<String, String> {
    read_doc(&domain)
}

#[tauri::command]
pub fn save_doc(domain: String, content: String) -> Result<String, String> {
    write_doc(&domain, &content)
}

#[tauri::command]
pub fn data_path() -> String {
    data_dir().display().to_string().trim_start_matches(r"\\?\").to_string()
}

fn copy_workspace(source: &std::path::Path, target: &std::path::Path, locator: &std::path::Path) -> Result<(), String> {
    if !target.is_absolute() { return Err("请输入绝对路径".into()); }
    fs::create_dir_all(target).map_err(|e| format!("无法创建目录: {e}"))?;
    let source = fs::canonicalize(source).map_err(|e| e.to_string())?;
    let target = fs::canonicalize(target).map_err(|e| e.to_string())?;
    if source == target { return Ok(()); }
    if fs::read_dir(&target).map_err(|e| e.to_string())?.next().is_some() {
        return Err("目标目录非空，请选择一个空目录；已有内容不会被覆盖".into());
    }
    let mut created = Vec::new();
    let result = (|| {
        for domain in ALLOWED_DOMAINS {
            let from = source.join(format!("{domain}.json"));
            if !from.exists() { continue; }
            let content = fs::read(&from).map_err(|e| e.to_string())?;
            serde_json::from_slice::<serde_json::Value>(&content).map_err(|e| format!("{domain} 数据损坏: {e}"))?;
            let to = target.join(format!("{domain}.json"));
            use std::io::Write;
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&to).map_err(|e| e.to_string())?;
            created.push(to);
            file.write_all(&content).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        }
        if let Some(parent) = locator.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let tmp = locator.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec(&target).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&tmp, locator).map_err(|e| format!("保存目录配置失败: {e}"))?;
        Ok(())
    })();
    if result.is_err() { for path in created { let _ = fs::remove_file(path); } }
    result
}

#[tauri::command]
pub fn migrate_data_directory(path: String) -> Result<String, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let source = data_dir();
    let target = PathBuf::from(path.trim());
    let locators = locator_paths();
    let locator = locators.iter().find(|p| p.exists()).or_else(|| locators.iter().find(|p| p.parent().is_some_and(|parent| writable(&parent.to_path_buf())))).ok_or("无法保存目录配置")?;
    copy_workspace(&source, &target, locator)?;
    let target = fs::canonicalize(&target).map_err(|e| e.to_string())?;
    let display = target.to_string_lossy().strip_prefix(r"\\?\").unwrap_or(&target.to_string_lossy()).to_string();
    *DATA_DIR.get().ok_or("数据目录尚未初始化")?.write().unwrap_or_else(|p| p.into_inner()) = target;
    Ok(display)
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    #[test]
    fn copies_all_domains_keeps_original_and_rejects_existing_data() {
        let root = std::env::temp_dir().join(format!("relay-migration-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let source = root.join("source");let target = root.join("target");let locator = root.join("location.json");
        fs::create_dir_all(&source).unwrap();
        for domain in ALLOWED_DOMAINS {fs::write(source.join(format!("{domain}.json")), "[1]").unwrap();}
        copy_workspace(&source, &target, &locator).unwrap();
        for domain in ALLOWED_DOMAINS {assert_eq!(fs::read_to_string(target.join(format!("{domain}.json"))).unwrap(), "[1]");assert!(source.join(format!("{domain}.json")).exists());}
        assert!(copy_workspace(&source, &target, &locator).is_err());
        assert!(copy_workspace(&source, std::path::Path::new("relative"), &locator).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_data_does_not_change_locator_or_leave_partial_copy() {
        let root = std::env::temp_dir().join(format!("relay-corrupt-{}", std::process::id()));let source=root.join("source");let target=root.join("target");let locator=root.join("location.json");
        fs::create_dir_all(&source).unwrap();fs::write(source.join("collections.json"), "[1]").unwrap();fs::write(source.join("environments.json"), "broken").unwrap();
        assert!(copy_workspace(&source,&target,&locator).is_err());assert!(!locator.exists());assert_eq!(fs::read_dir(target).unwrap().count(),0);fs::remove_dir_all(root).unwrap();
    }
}

/// The path checks every export goes through. The native save dialog is the
/// user's authorisation, but the string still arrives from web content, so:
/// absolute only, the folder must already exist, and never inside Relay's own
/// data dir — saving a response must not be able to rewrite the collection.
fn export_target(path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err("只能写入绝对路径".into());
    }
    let parent = target.parent().ok_or("缺少所在目录")?;
    if !parent.is_dir() {
        return Err(format!("目录不存在: {}", parent.display()));
    }
    let resolved_parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let resolved_data = fs::canonicalize(data_dir()).map_err(|e| e.to_string())?;
    if resolved_parent.starts_with(resolved_data) {
        return Err("不能写入 Relay 自己的数据目录".into());
    }
    Ok(target)
}

#[tauri::command]
pub fn save_text(path: String, contents: String) -> Result<String, String> {
    let target = export_target(&path)?;
    fs::write(&target, contents.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
    Ok(target.display().to_string())
}

/// Binary exports (a downloaded image, an attachment) go over the bridge as
/// base64 and are decoded here. Routing them through a JS string instead would
/// re-encode the bytes as UTF-8 and silently corrupt anything non-ASCII.
#[tauri::command]
pub fn save_base64(path: String, contents_base64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(|e| format!("Base64 解码失败: {e}"))?;
    let target = export_target(&path)?;
    fs::write(&target, bytes).map_err(|e| format!("写入失败: {e}"))?;
    Ok(target.display().to_string())
}

/// What an upload path actually points at, so the editor can show a size and
/// catch a stale path before the request goes out.
#[tauri::command]
pub fn file_meta(path: String) -> Result<serde_json::Value, String> {
    let meta = std::fs::metadata(&path).map_err(|err| format!("{path} 打不开：{err}"))?;
    if !meta.is_file() {
        return Err(format!("{path} 不是文件"));
    }
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(serde_json::json!({ "path": path, "name": name, "size": meta.len() }))
}
