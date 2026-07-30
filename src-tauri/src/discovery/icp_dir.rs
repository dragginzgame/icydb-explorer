use crate::error::AppError;

use super::types::{CanisterArtifact, Environment, IdentityRef, Project};
use serde_json::Value;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// Read a project's `.icp/` layout and build up its `Project` description:
/// which environments exist, what replica each points at, the root
/// canister id (if deployed), the default identity, and the canister
/// artifacts (`.did` files) available locally.
pub fn discover(project_root: &Path) -> Result<Project, AppError> {
    let icp_dir = project_root.join(".icp");
    if !icp_dir.is_dir() {
        return Err(AppError::Io(format!(
            "{} is not a directory; expected an .icp project layout at {}",
            icp_dir.display(),
            project_root.display()
        )));
    }

    let root_canister_id = read_root_canister_id(&icp_dir, project_root)?;
    let identity = read_default_identity(&icp_dir)?;
    let environments = read_environments(&icp_dir, &root_canister_id, &identity)?;

    Ok(Project {
        root: project_root.to_path_buf(),
        environments,
    })
}

/// Parse a JSON file, mapping any IO failure to `AppError::Io` and any
/// malformed-JSON failure to `AppError::Parse`.
fn read_json(path: &Path) -> Result<Value, AppError> {
    let text = fs::read_to_string(path)
        .map_err(|e| AppError::Io(format!("failed to read {}: {e}", path.display())))?;
    serde_json::from_str(&text)
        .map_err(|e| AppError::Parse(format!("failed to parse {} as JSON: {e}", path.display())))
}

/// List the entries of a directory, treating a missing directory as "no
/// entries" rather than an error (a project need not have deployed
/// canisters, custom ports, or identities yet). Any other IO failure
/// (permissions, etc) is propagated.
fn list_dir(dir: &Path) -> Result<Vec<PathBuf>, AppError> {
    let read_dir = match fs::read_dir(dir) {
        Ok(read_dir) => read_dir,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(AppError::Io(format!(
                "failed to read {}: {e}",
                dir.display()
            )))
        }
    };

    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry
            .map_err(|e| AppError::Io(format!("failed to read entry in {}: {e}", dir.display())))?;
        entries.push(entry.path());
    }
    entries.sort();
    Ok(entries)
}

/// Step 5.3: find `.icp/cache/mappings/*.ids.json`, preferring the file
/// whose stem matches the project directory's name, else the first one
/// found, and read its `root` key.
fn read_root_canister_id(icp_dir: &Path, project_root: &Path) -> Result<Option<String>, AppError> {
    let mappings_dir = icp_dir.join("cache").join("mappings");
    let candidates: Vec<(String, PathBuf)> = list_dir(&mappings_dir)?
        .into_iter()
        .filter_map(|path| {
            let stem = path
                .file_name()?
                .to_str()?
                .strip_suffix(".ids.json")?
                .to_string();
            Some((stem, path))
        })
        .collect();

    let project_name = project_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let chosen = candidates
        .iter()
        .find(|(stem, _)| stem == project_name)
        .or_else(|| candidates.first());

    let path = match chosen {
        Some((_, path)) => path,
        None => return Ok(None),
    };

    let value = read_json(path)?;
    let root = value.get("root").and_then(Value::as_str).ok_or_else(|| {
        AppError::Parse(format!(
            "{} is missing a \"root\" string field",
            path.display()
        ))
    })?;

    Ok(Some(root.to_string()))
}

/// Step 5.4: read the default identity's name from `identity_defaults.json`,
/// look it up in `identity_list.json` for its algorithm, and point at its
/// pem file under `cli-home/identity/keys/`. An identity whose `kind` is
/// not `"pem"` (e.g. `"anonymous"`) resolves to `None` rather than an
/// error, since it simply has no pem to load.
fn read_default_identity(icp_dir: &Path) -> Result<Option<IdentityRef>, AppError> {
    let identity_dir = icp_dir.join("cli-home").join("identity");
    let defaults_path = identity_dir.join("identity_defaults.json");
    let list_path = identity_dir.join("identity_list.json");

    if !defaults_path.is_file() || !list_path.is_file() {
        return Ok(None);
    }

    let defaults = read_json(&defaults_path)?;
    let default_name = defaults
        .get("default")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::Parse(format!(
                "{} is missing a \"default\" string field",
                defaults_path.display()
            ))
        })?;

    let list = read_json(&list_path)?;
    let identities = list
        .get("identities")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            AppError::Parse(format!(
                "{} is missing an \"identities\" object",
                list_path.display()
            ))
        })?;

    let entry = identities.get(default_name).ok_or_else(|| {
        AppError::Parse(format!(
            "{} names \"{default_name}\" as the default identity, but it is not listed in {}",
            defaults_path.display(),
            list_path.display()
        ))
    })?;

    let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != "pem" {
        return Ok(None);
    }

    let algorithm = entry
        .get("algorithm")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::Parse(format!(
                "identity \"{default_name}\" in {} is missing an \"algorithm\" field",
                list_path.display()
            ))
        })?
        .to_string();

    let pem_path = identity_dir
        .join("keys")
        .join(format!("{default_name}.pem"));

    Ok(Some(IdentityRef {
        name: default_name.to_string(),
        algorithm,
        pem_path,
    }))
}

/// Step 5.2: each `.icp/cli-home/port-descriptors/*.json` file describes
/// one environment.
fn read_environments(
    icp_dir: &Path,
    root_canister_id: &Option<String>,
    identity: &Option<IdentityRef>,
) -> Result<Vec<Environment>, AppError> {
    let port_descriptors_dir = icp_dir.join("cli-home").join("port-descriptors");

    let mut environments = Vec::new();
    for path in list_dir(&port_descriptors_dir)? {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let value = read_json(&path)?;
        let name = value
            .get("network")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::Parse(format!(
                    "{} is missing a \"network\" string field",
                    path.display()
                ))
            })?
            .to_string();

        let gateway = value.get("gateway").ok_or_else(|| {
            AppError::Parse(format!(
                "{} is missing a \"gateway\" object",
                path.display()
            ))
        })?;
        let ip = gateway.get("ip").and_then(Value::as_str).ok_or_else(|| {
            AppError::Parse(format!(
                "{} gateway is missing an \"ip\" string field",
                path.display()
            ))
        })?;
        let port = gateway.get("port").and_then(Value::as_u64).ok_or_else(|| {
            AppError::Parse(format!(
                "{} gateway is missing a \"port\" number field",
                path.display()
            ))
        })?;
        let replica_url = format!("http://{ip}:{port}");

        let artifacts = read_artifacts(icp_dir, &name)?;

        environments.push(Environment {
            name,
            replica_url,
            root_canister_id: root_canister_id.clone(),
            identity: identity.clone(),
            artifacts,
        });
    }

    Ok(environments)
}

/// Step 5.5: each subdirectory of `.icp/<env>/canisters/` is one locally
/// built canister artifact, named for its role, holding `<role>.did`.
fn read_artifacts(icp_dir: &Path, env_name: &str) -> Result<Vec<CanisterArtifact>, AppError> {
    let canisters_dir = icp_dir.join(env_name).join("canisters");

    let mut artifacts = Vec::new();
    for path in list_dir(&canisters_dir)? {
        if !path.is_dir() {
            continue;
        }
        let role = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        let did_path = path.join(format!("{role}.did"));
        artifacts.push(CanisterArtifact { role, did_path });
    }

    Ok(artifacts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixture() -> Project {
        discover(Path::new("tests/fixtures/icp_project")).expect("discovery should succeed")
    }

    #[test]
    fn finds_the_local_environment() {
        let project = fixture();
        let names: Vec<&str> = project
            .environments
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(names, vec!["local"]);
    }

    #[test]
    fn builds_replica_url_from_gateway() {
        let env = &fixture().environments[0];
        assert_eq!(env.replica_url, "http://127.0.0.1:8000");
    }

    #[test]
    fn reads_root_canister_id_from_ids_mapping() {
        let env = &fixture().environments[0];
        assert_eq!(
            env.root_canister_id.as_deref(),
            Some("igqk7-g3777-77774-qaaba-cai")
        );
    }

    #[test]
    fn resolves_default_identity_with_algorithm_and_pem_path() {
        let env = &fixture().environments[0];
        let identity = env.identity.as_ref().expect("identity should resolve");
        assert_eq!(identity.name, "demo-local");
        assert_eq!(identity.algorithm, "secp256k1");
        assert!(identity.pem_path.ends_with("keys/demo-local.pem"));
    }

    #[test]
    fn lists_canister_artifacts_by_role() {
        let env = &fixture().environments[0];
        let mut roles: Vec<&str> = env.artifacts.iter().map(|a| a.role.as_str()).collect();
        roles.sort_unstable();
        assert_eq!(roles, vec!["root", "user_hub"]);
    }

    #[test]
    fn missing_icp_directory_is_an_error_not_a_panic() {
        assert!(discover(Path::new("tests/fixtures/does_not_exist")).is_err());
    }
}
