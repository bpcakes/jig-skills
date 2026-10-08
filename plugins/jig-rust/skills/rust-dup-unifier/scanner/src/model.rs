use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct MemberContract {
    pub visibility: String,
    pub attributes: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Declaration {
    pub kind: String,
    pub name: String,
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub visibility: String,
    pub owner: Option<String>,
    pub attributes: Vec<String>,
    pub members: BTreeMap<String, String>,
    pub methods: BTreeMap<String, String>,
    pub signature: String,
    pub header: String,
    pub shape: String,
    pub member_contracts: BTreeMap<String, MemberContract>,
    pub body_tokens: Vec<String>,
    pub calls: BTreeSet<String>,
    pub literals: Vec<String>,
    pub module: Vec<String>,
    pub crate_root: String,
    #[serde(skip)]
    pub impl_target: Option<Vec<String>>,
    #[serde(skip)]
    pub impl_trait: Option<String>,
}

impl Declaration {
    pub fn id(&self) -> String {
        format!(
            "{}:{}:{}:{}:{}",
            self.file, self.line, self.column, self.kind, self.name
        )
    }

    pub fn callable(&self) -> bool {
        matches!(self.kind.as_str(), "function" | "method")
    }

    pub fn stream(&self) -> &'static str {
        if self.callable() {
            "callables"
        } else {
            "types"
        }
    }

    pub fn summary(&self, details: bool) -> serde_json::Value {
        if details {
            serde_json::to_value(self).expect("declaration serialization is infallible")
        } else {
            serde_json::json!({
                "kind": self.kind, "name": self.name, "file": self.file,
                "line": self.line, "column": self.column,
                "visibility": self.visibility, "owner": self.owner,
            })
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub id: String,
    pub stream: String,
    pub left: String,
    pub right: String,
    pub score: f64,
    pub exact: bool,
    pub signals: BTreeMap<String, f64>,
    pub divergences: Vec<String>,
    pub rationale: Vec<String>,
}

pub fn stable_hash(value: &str) -> String {
    blake3::hash(value.as_bytes()).to_hex()[..16].to_string()
}

#[derive(Debug, Default, Serialize)]
pub struct Coverage {
    pub rust_file_count: usize,
    pub rust_files: Vec<String>,
    pub cargo_manifests: Vec<String>,
    pub skipped: BTreeMap<String, usize>,
    pub skipped_paths: BTreeMap<String, BTreeSet<String>>,
    pub skipped_items: Vec<serde_json::Value>,
    pub skipped_item_count: usize,
    pub parse_errors: Vec<serde_json::Value>,
    pub unresolved_impls: Vec<serde_json::Value>,
    pub unexpanded_macros: Vec<serde_json::Value>,
    pub module_gaps: Vec<serde_json::Value>,
}

impl Coverage {
    pub fn skip(&mut self, reason: &str, path: &str) {
        self.skipped_paths
            .entry(reason.into())
            .or_default()
            .insert(path.into());
    }
}
