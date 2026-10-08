use std::{fs, process::Command};

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_rust-dup-unifier"))
}

#[test]
fn json_cli_defaults_ids_compactness_and_output_file() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("lib.rs"),
        "struct A {x:u8,y:u8} struct B {x:u8,y:u8}",
    )
    .unwrap();
    let output = binary()
        .arg(dir.path())
        .args(["--format", "json"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["version"], 3);
    assert_eq!(json["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(json["candidates"][0]["exact"], true);
    assert!(
        json["candidates"][0]["id"]
            .as_str()
            .unwrap()
            .starts_with("DU-CAND-")
    );
    let id = json["candidates"][0]["left"].as_str().unwrap();
    assert!(json["declarations"][id].get("body_tokens").is_none());
    let destination = dir.path().join("report.json");
    let written = binary()
        .arg(dir.path())
        .args(["--format", "json", "--output"])
        .arg(&destination)
        .output()
        .unwrap();
    assert!(written.status.success());
    assert!(written.stdout.is_empty());
    assert_eq!(fs::read(destination).unwrap(), output.stdout);
}

#[test]
fn markdown_reports_clusters_divergences_and_limits() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("lib.rs"),
        "struct A {x:u8,y:u8} struct B {x:u8,y:u8} struct C {x:u8,y:u8}",
    )
    .unwrap();
    let output = binary()
        .arg(dir.path())
        .args(["--max-candidates", "1"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    for expected in [
        "## Coverage",
        "Truncated",
        "## Clusters",
        "DU-GROUP-",
        "DU-CAND-",
        "mechanically exact",
        "No mechanical divergence",
        "lib.rs:1:",
    ] {
        assert!(text.contains(expected), "missing {expected}");
    }
}

#[test]
fn excluded_test_scope_has_actionable_error() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("tests")).unwrap();
    fs::write(dir.path().join("tests/cases.rs"), "struct A;").unwrap();
    let output = binary()
        .arg(dir.path())
        .args(["--scope", "tests"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--include-tests"));
    assert!(
        binary()
            .arg(dir.path())
            .args(["--scope", "tests", "--include-tests"])
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn invalid_options_fail_before_scanning() {
    for args in [
        vec!["--min-score", "NaN"],
        vec!["--min-score", "1.1"],
        vec!["--max-candidates", "0"],
        vec!["--include-exact", "--exclude-exact"],
    ] {
        assert!(!binary().args(args).output().unwrap().status.success());
    }
}
