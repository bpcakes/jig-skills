use std::time::Duration;

#[derive(Clone, Debug)]
pub struct HttpOptions {
    pub endpoint: String,
    pub timeout: Duration,
    pub retries: u32,
    pub headers: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
pub struct RpcOptions {
    pub endpoint: String,
    pub timeout: Duration,
    pub retry_limit: u32,
    pub headers: Vec<(String, String)>,
}

impl HttpOptions {
    pub fn validate(&self) -> Result<(), String> {
        if self.endpoint.is_empty() {
            return Err("empty endpoint".to_owned());
        }
        if self.timeout.is_zero() {
            return Err("zero timeout".to_owned());
        }
        Ok(())
    }
}

impl RpcOptions {
    pub fn validate(&self) -> Result<(), String> {
        if self.endpoint.is_empty() {
            return Err("empty endpoint".to_owned());
        }
        if self.timeout.is_zero() {
            return Err("zero timeout".to_owned());
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum HttpError {
    Timeout,
    Closed,
    Io(String),
    InvalidHeader { name: String },
}

#[derive(Debug)]
pub enum RpcError {
    Timeout,
    Closed,
    Io(String),
    Unavailable { code: u16 },
}

pub trait ReadStore {
    type Error;

    fn get(&self, key: &str) -> Result<Vec<u8>, Self::Error>;
    fn list(&self, prefix: &str) -> Result<Vec<String>, Self::Error>;
}

pub trait FetchStore {
    type Error;

    fn get(&self, key: &str) -> Result<Vec<u8>, Self::Error>;
    fn list(&self, prefix: &str) -> Result<Vec<String>, Self::Error>;
    fn stats(&self) -> usize;
}

pub struct ExactLeft {
    pub id: u64,
    pub name: String,
}

pub struct ExactRight {
    pub id: u64,
    pub name: String,
}

pub fn normalize_http(input: &str) -> String {
    let trimmed = input.trim();
    let without_scheme = trimmed.strip_prefix("http://").unwrap_or(trimmed);
    without_scheme.trim_end_matches('/').to_ascii_lowercase()
}

pub fn normalize_rpc(input: &str) -> String {
    let trimmed = input.trim();
    let without_scheme = trimmed.strip_prefix("rpc://").unwrap_or(trimmed);
    without_scheme.trim_end_matches('/').to_ascii_lowercase()
}

pub fn literal_braces_are_not_items() -> &'static str {
    // struct Fake { field: u8 }
    r###"trait AlsoFake { fn nope(&self) { } }"###
}
