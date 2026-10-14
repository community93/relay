use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::types::Settings;

pub struct AppState {
    /// One client per transport profile (TLS verification / proxy / redirects).
    /// All of them share the cookie jar below so cookies survive across requests.
    clients: Mutex<HashMap<String, reqwest::Client>>,
    jar: Mutex<Arc<reqwest::cookie::Jar>>,
    pub running: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    pub sockets: Mutex<HashMap<String, crate::ws::SocketHandle>>,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            clients: Mutex::new(HashMap::new()),
            jar: Mutex::new(Arc::new(reqwest::cookie::Jar::default())),
            running: Mutex::new(HashMap::new()),
            sockets: Mutex::new(HashMap::new()),
        }
    }
}

impl AppState {
    fn jar(&self) -> Arc<reqwest::cookie::Jar> {
        self.jar.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn clients(&self) -> std::sync::MutexGuard<'_, HashMap<String, reqwest::Client>> {
        self.clients.lock().unwrap_or_else(|p| p.into_inner())
    }
}

pub fn settings_of(settings: Option<&Settings>) -> Settings {
    settings.cloned().unwrap_or_else(|| Settings {
        timeout_ms: Some(60_000),
        follow_redirects: true,
        ssl_verify: true,
        proxy: None,
        max_redirects: None,
        cookie_jar: true,
    })
}

/// `allowed_hosts` is the AI connection's host allowlist; empty means a human
/// pressed Send and every hop is fair game. When it is set, the redirect policy
/// re-checks each hop, which means the policy -- and therefore the client -- is
/// specific to that allowlist and cannot share the cache with unrestricted runs.
pub fn client_for(
    state: &AppState,
    s: &Settings,
    allowed_hosts: &[String],
) -> Result<reqwest::Client, String> {
    let proxy = s.proxy.clone().unwrap_or_default().trim().to_string();
    let pinned = allowed_hosts.join(",");
    let key = format!(
        "v={}&proxy={}&redirects={}&max={}&hosts={}",
        s.ssl_verify,
        proxy,
        s.follow_redirects,
        s.max_redirects.unwrap_or(10),
        pinned
    );
    {
        let map = state.clients();
        if let Some(existing) = map.get(&key) {
            return Ok(existing.clone());
        }
    }

    let redirect_policy = if !s.follow_redirects {
        reqwest::redirect::Policy::none()
    } else if allowed_hosts.is_empty() {
        reqwest::redirect::Policy::limited(s.max_redirects.unwrap_or(10))
    } else {
        crate::http::pinned_policy(s.max_redirects.unwrap_or(10), allowed_hosts)
    };

    let mut builder = reqwest::Client::builder()
        .user_agent("Relay/0.1")
        .redirect(redirect_policy)
        .danger_accept_invalid_certs(!s.ssl_verify)
        .tcp_nodelay(true);

    if s.cookie_jar {
        builder = builder.cookie_provider(state.jar());
    }
    if !proxy.is_empty() {
        let parsed = reqwest::Proxy::all(&proxy).map_err(|e| format!("代理地址无效: {e}"))?;
        builder = builder.proxy(parsed);
    }

    let client = builder
        .build()
        .map_err(|e| format!("无法创建 HTTP 客户端: {e}"))?;
    state.clients().insert(key, client.clone());
    Ok(client)
}
