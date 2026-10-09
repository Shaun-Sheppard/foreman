//! The DevOps PAT lives only in the OS keychain (NFR1). It never reaches SQLite,
//! logs, the webview or a prompt.

use std::sync::Mutex;

const SERVICE: &str = "uk.co.shepparddigital.foreman";
const ACCOUNT: &str = "azure-devops-pat";

pub enum Secrets {
    Keychain,
    /// Fixture mode keeps the token in memory so tests never touch the real keychain.
    Memory(Mutex<Option<String>>),
}

impl Secrets {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("Keychain unavailable: {e}"))
    }

    pub fn pat(&self) -> Result<Option<String>, String> {
        match self {
            Secrets::Memory(m) => Ok(m.lock().unwrap().clone()),
            Secrets::Keychain => match Self::entry()?.get_password() {
                Ok(p) => Ok(Some(p)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(format!("Couldn't read the token from the keychain: {e}")),
            },
        }
    }

    pub fn set_pat(&self, pat: &str) -> Result<(), String> {
        match self {
            Secrets::Memory(m) => {
                *m.lock().unwrap() = Some(pat.to_string());
                Ok(())
            }
            Secrets::Keychain => Self::entry()?
                .set_password(pat)
                .map_err(|e| format!("Couldn't save the token to the keychain: {e}")),
        }
    }
}
