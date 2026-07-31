//! Filename gate — refuse credential-shaped paths unless override flag set.
//! Prior art: caveman-style safeguards (JuliusBrussee/caveman).

use regex::Regex;
use std::sync::LazyLock;

static RE_SENSITIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^\.env(\..+)?$|credential|secret|^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$|\.pem$|\.p12$|\.pfx$|\.keystore$|\.jks$|^\.netrc$|^\.npmrc$|^\.pypirc$|\.kdbx$|^known_hosts$|^\.htpasswd$|\.tfstate(\.backup)?$"
    ).unwrap()
});

static SENSITIVE_DIRS: [&str; 4] = [".aws", ".ssh", ".gnupg", ".kube"];

/// Check if a path looks like it might contain credentials.
/// Returns None if safe, Some(message) if it should be refused.
pub fn check_path(path: &str) -> Option<String> {
    // Check path components for sensitive directories
    for component in path.split('/').chain(path.split('\\')) {
        if SENSITIVE_DIRS.contains(&component) {
            return Some(format!("refusing {}: filename suggests credentials; pass --allow-sensitive to override", path));
        }
    }

    // Check basename
    let basename = path.rsplit('/').next()
        .unwrap_or(path)
        .rsplit('\\').next()
        .unwrap_or(path);
    
    let lower = basename.to_lowercase();
    if RE_SENSITIVE.is_match(&lower) {
        return Some(format!("refusing {}: filename suggests credentials; pass --allow-sensitive to override", path));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_env_files() {
        assert!(check_path(".env").is_some());
        assert!(check_path(".env.local").is_some());
        assert!(check_path(".env.production").is_some());
        assert!(check_path("config/.env.test").is_some());
    }

    #[test]
    fn test_ssh_keys() {
        assert!(check_path("id_rsa").is_some());
        assert!(check_path("id_rsa.pub").is_some());
        assert!(check_path("id_ed25519").is_some());
        assert!(check_path("id_ecdsa").is_some());
        assert!(check_path("id_dsa").is_some());
        assert!(check_path("/home/user/.ssh/id_rsa").is_some());
    }

    #[test]
    fn test_credential_in_name() {
        assert!(check_path("prod-credentials.json").is_some());
        assert!(check_path("api-secret.txt").is_some());
    }

    #[test]
    fn test_certificate_files() {
        assert!(check_path("server.pem").is_some());
        assert!(check_path("cert.p12").is_some());
        assert!(check_path("key.pfx").is_some());
        assert!(check_path("app.keystore").is_some());
        assert!(check_path("trust.jks").is_some());
    }

    #[test]
    fn test_config_files() {
        assert!(check_path(".netrc").is_some());
        assert!(check_path(".npmrc").is_some());
        assert!(check_path(".pypirc").is_some());
        assert!(check_path("passwords.kdbx").is_some());
    }

    #[test]
    fn test_known_hosts() {
        assert!(check_path("known_hosts").is_some());
        assert!(check_path(".htpasswd").is_some());
    }

    #[test]
    fn test_terraform_state() {
        assert!(check_path("terraform.tfstate").is_some());
        assert!(check_path("prod.tfstate.backup").is_some());
    }

    #[test]
    fn test_sensitive_directories() {
        assert!(check_path("/home/user/.aws/config").is_some());
        assert!(check_path("/home/user/.aws/credentials").is_some());
        assert!(check_path(".ssh/config").is_some());
        assert!(check_path("backup/.gnupg/private.key").is_some());
        assert!(check_path("/etc/.kube/config").is_some());
    }

    #[test]
    fn test_safe_files() {
        assert!(check_path("envelope.txt").is_none());
        assert!(check_path("README.md").is_none());
        assert!(check_path("config.json").is_none());
        assert!(check_path("app.log").is_none());
    }

    #[test]
    fn test_envrc_passes() {
        // .envrc does NOT match ^\.env(\..+)?$ because there's no dot after env
        assert!(check_path(".envrc").is_none());
    }

    #[test]
    fn test_secretary_refused() {
        // "secretary" contains "secret" substring - accepted overcaution per contract
        assert!(check_path("secretary-notes.md").is_some());
    }

    #[test]
    fn test_windows_paths() {
        assert!(check_path(r"C:\Users\dev\.aws\credentials").is_some());
        assert!(check_path(r".\config\.ssh\id_rsa").is_some());
    }
}
