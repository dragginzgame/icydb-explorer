use serde::Serialize;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub root: PathBuf,
    pub environments: Vec<Environment>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub name: String,
    pub replica_url: String,
    pub root_canister_id: Option<String>,
    pub identity: Option<IdentityRef>,
    pub artifacts: Vec<CanisterArtifact>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRef {
    pub name: String,
    pub algorithm: String,
    pub pem_path: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanisterArtifact {
    pub role: String,
    pub did_path: PathBuf,
}
