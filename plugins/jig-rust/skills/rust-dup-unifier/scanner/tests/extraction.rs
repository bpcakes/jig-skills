use ra_ap_syntax::Edition;
use rust_dup_unifier::{
    compare, extract,
    model::{Coverage, Declaration},
    repository::{Options, scan},
};
use std::fs;

fn parse(source: &str) -> Vec<Declaration> {
    let mut coverage = Coverage::default();
    let mut items = extract::parse_file(
        source,
        "lib.rs",
        "lib.rs",
        &[],
        Edition::Edition2024,
        false,
        &mut coverage,
    );
    assert!(
        coverage.parse_errors.is_empty(),
        "{:?}",
        coverage.parse_errors
    );
    extract::attach_methods(&mut items, &mut coverage);
    items
}

#[test]
fn field_contracts_and_trait_bounds_prevent_exactness() {
    let items = parse(
        r#"
        struct A { #[serde(rename="wire")] pub id: u64, pub name: String }
        struct B { id: u64, name: String }
        trait Store: Send + Sync + 'static { fn get(&self); fn put(&self); }
        trait LocalStore { fn get(&self); fn put(&self); }
    "#,
    );
    let structs: Vec<_> = items.iter().filter(|i| i.kind == "struct").collect();
    let pair = compare::compare(structs[0], structs[1]).unwrap();
    assert!(!pair.exact);
    assert!(
        pair.divergences
            .iter()
            .any(|s| s.contains("Member visibility/attributes"))
    );
    let traits: Vec<_> = items.iter().filter(|i| i.kind == "trait").collect();
    assert!(!compare::compare(traits[0], traits[1]).unwrap().exact);
    assert!(traits[0].header.contains("Send + Sync"));
}

#[test]
fn functions_and_methods_share_comparison_pool() {
    let items = parse(
        "fn free(x:u32)->u32 { let y = x + 1; y * y } struct A; impl A { fn member(x:u32)->u32 { let y = x + 1; y * y } }",
    );
    let (pairs, stats, _) = compare::generate(&items, 0.68, 100, true);
    assert_eq!(stats.potential_pairs, 1);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0].stream, "callables");
}

#[test]
fn fn_bounds_nested_generics_lifetimes_and_tuple_fields() {
    let items = parse(
        "struct Handler<'a, 'b, F> where F: Fn(Request) -> Response { callback: F, state: Result<(Vec<u8>, usize), String>, a: &'a str, b: &'b str } struct Pair(pub Result<(Vec<u8>, usize), String>, u64);",
    );
    assert_eq!(items[0].shape, "record");
    assert_eq!(items[0].members.len(), 4);
    assert_eq!(
        items[0].members["state"],
        "Result < ( Vec < u8 > , usize ) , String >"
    );
    assert_eq!(items[0].members["b"], "& 'b str");
    assert_eq!(items[1].members.len(), 2);
    assert_eq!(items[1].member_contracts["0"].visibility, "pub");
}

#[test]
fn enum_shifts_turbofish_payloads_and_attributes() {
    let items = parse(
        r#"enum Flags { #[cfg(unix)] A = 1 << 0, B = call::<u8, u16>(), C = 1 >> 1 } enum Data { One(Result<(Vec<u8>,usize),String>, u64), Two { #[serde(rename="v")] value: Vec<(u8,u8)> }, Three }"#,
    );
    assert_eq!(items[0].members.len(), 3);
    assert!(items[0].members["A"].contains("1 << 0"));
    assert!(items[0].members["B"].contains("u8 , u16"));
    assert!(!items[0].member_contracts["A"].attributes.is_empty());
    assert_eq!(items[1].members.len(), 3);
    assert!(items[1].members["One"].contains("String >"));
    assert!(!items[1].member_contracts["Two.value"].attributes.is_empty());
}

#[test]
fn multiline_attributes_survive_comments_and_preserve_string_contents() {
    let items = parse(
        "#[derive(\nClone,\nDebug\n)]\n// comment\n/// documentation\n#[label = \"a  b\"]\nstruct A { x:u8,y:u8 } #[label = \"a b\"] struct B { x:u8,y:u8 }",
    );
    assert_eq!(items[0].attributes.len(), 2);
    assert!(items[0].attributes[1].contains("a  b"));
    assert!(!compare::compare(&items[0], &items[1]).unwrap().exact);
}

#[test]
fn many_attributes_are_linear_parser_input() {
    let source = format!("{} struct A {{x:u8,y:u8}}", "#[a] ".repeat(1000));
    assert_eq!(parse(&source)[0].attributes.len(), 1000);
}

#[test]
fn macros_comments_and_signature_continuations_are_not_phantom_items() {
    let items = parse(
        r##"
        macro_rules! make { ($name:ident) => { struct $name {x:u8} impl $name { fn id(&self) {} } } }
        make!(Generated);
        fn real() ->
        impl Iterator<Item=u8> { [1,2].into_iter() }
        fn text() -> &'static str { r#"struct Fake {x:u8}"# }
    "##,
    );
    assert_eq!(
        items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
        vec!["real", "text"]
    );
}

#[test]
fn inline_test_modules_and_cfg_boolean_logic() {
    let source = r#"
        #[cfg(test)] mod hidden { struct X {x:u8,y:u8} mod nested { fn f() {} } }
        #[cfg(all(test, feature="x"))] struct Y {x:u8,y:u8}
        #[cfg(any(test, feature="x"))] struct Possible {x:u8,y:u8}
        #[cfg(not(test))] struct Production {x:u8,y:u8}
        #[tokio::test] async fn hidden_test() {}
    "#;
    let items = parse(source);
    assert_eq!(
        items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
        vec!["Possible", "Production"]
    );
    let mut coverage = Coverage::default();
    let all = extract::parse_file(
        source,
        "lib.rs",
        "lib.rs",
        &[],
        Edition::Edition2024,
        true,
        &mut coverage,
    );
    assert_eq!(all.len(), 6);
}

#[test]
fn signature_keeps_array_lengths_and_nested_types() {
    let items = parse(
        "fn a(x: Result<(Vec<u8>, usize), String>, a: [u8; 8]) {} fn b(x: Result<(Vec<u8>, usize), String>, a: [u8; 9]) {}",
    );
    assert!(items[0].signature.contains("[ u8 ; 8 ]"));
    assert_ne!(items[0].signature, items[1].signature);
}

#[test]
fn generated_banners_use_comments_not_substrings() {
    for source in [
        "// @generated by bindgen\nstruct A;",
        "/*\n * This file is automatically generated.\n */\nstruct A;",
        "/* license */\n// generated by tool\nstruct A;",
    ] {
        assert!(extract::generated_file(
            source,
            "normal.rs",
            Edition::Edition2024
        ));
    }
    for source in [
        "/// generated by the server\nstruct A;",
        "/** generated by the server */\nstruct A;",
        "const HELP:&str=\"generated by tool\";",
    ] {
        assert!(!extract::generated_file(
            source,
            "keybindings.rs",
            Edition::Edition2024
        ));
    }
}

#[test]
fn syntax_errors_exclude_file_and_have_anchors() {
    let mut coverage = Coverage::default();
    let items = extract::parse_file(
        "struct Broken { field: }",
        "bad.rs",
        "bad.rs",
        &[],
        Edition::Edition2024,
        false,
        &mut coverage,
    );
    assert!(items.is_empty());
    assert!(!coverage.parse_errors.is_empty());
    assert_eq!(coverage.parse_errors[0]["file"], "bad.rs");
    assert!(coverage.parse_errors[0]["line"].as_u64().unwrap() >= 1);
}

#[test]
fn distinct_newtypes_are_negative_control() {
    let items = parse("struct UserId(u64); struct OrderId(u64);");
    assert!(compare::generate(&items, 0.0, 100, true).0.is_empty());
}

#[test]
fn tuple_positions_do_not_count_as_names() {
    let items = parse("struct A(u64, u32); struct B(u64, u32);");
    assert_eq!(
        compare::compare(&items[0], &items[1]).unwrap().signals["member_name_overlap"],
        0.0
    );
}

#[test]
fn same_line_declarations_have_distinct_stable_ids() {
    let items = parse("mod a { struct X {x:u8,y:u8} } mod b { struct X {x:u8,y:u8} }");
    assert_ne!(items[0].id(), items[1].id());
    let pair = compare::compare(&items[0], &items[1]).unwrap();
    assert_eq!(pair.id, compare::compare(&items[1], &items[0]).unwrap().id);
}

fn write(root: &std::path::Path, file: &str, source: &str) {
    let path = root.join(file);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, source).unwrap();
}

#[test]
fn cross_file_methods_attach_only_to_resolved_module_paths() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "Cargo.toml",
        "[package]\nname='fixture'\nversion='0.1.0'\nedition='2024'\n",
    );
    write(
        dir.path(),
        "src/lib.rs",
        "mod extra; struct A {x:u8,y:u8} mod sibling { struct A {x:u8,y:u8} }",
    );
    write(
        dir.path(),
        "src/extra.rs",
        "impl crate::A { fn helper(&self)->u8 {self.x + self.y} } impl Imported { fn uncertain() {} }",
    );
    let result = scan(
        dir.path(),
        &Options {
            details: true,
            ..Default::default()
        },
    )
    .unwrap();
    let main = result
        .declarations
        .values()
        .find(|i| i["name"] == "A" && i["module"].as_array().unwrap().is_empty())
        .unwrap();
    assert!(main["methods"].get("helper").is_some());
    let sibling = result
        .declarations
        .values()
        .find(|i| i["name"] == "A" && !i["module"].as_array().unwrap().is_empty())
        .unwrap();
    assert!(sibling["methods"].as_object().unwrap().is_empty());
    assert_eq!(result.coverage.unresolved_impls.len(), 1);
}

#[test]
fn external_test_modules_are_excluded_even_without_test_filename() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "lib.rs",
        "#[cfg(test)] mod checks; struct A {x:u8,y:u8}",
    );
    write(dir.path(), "checks.rs", "struct TestOnly {x:u8,y:u8}");
    let result = scan(
        dir.path(),
        &Options {
            details: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        result
            .declarations
            .values()
            .all(|i| i["name"] != "TestOnly")
    );
    assert!(result.coverage.skipped_paths["test_module"].contains("checks.rs"));
    let all = scan(
        dir.path(),
        &Options {
            details: true,
            include_tests: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(all.declarations.values().any(|i| i["name"] == "TestOnly"));
}

#[test]
fn paths_globs_generated_files_and_scopes_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    for file in [
        "src/build/a.rs",
        "src/out/a.rs",
        "src/bench/a.rs",
        "src/keybindings.rs",
        "src/generated.rs",
        "tests/a.rs",
        "vendor/a.rs",
        "src/omit.rs",
    ] {
        write(dir.path(), file, "struct A {x:u8,y:u8}");
    }
    let result = scan(
        dir.path(),
        &Options {
            exclude: vec!["**/omit.rs".into()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(result.coverage.rust_file_count, 4);
    for (reason, path) in [
        ("generated_file", "src/generated.rs"),
        ("test_path", "tests"),
        ("default_directory", "vendor"),
        ("user_glob", "src/omit.rs"),
    ] {
        assert!(
            result.coverage.skipped_paths[reason].contains(path),
            "{reason}"
        );
    }
    assert!(
        scan(
            dir.path(),
            &Options {
                scope: vec!["../outside".into()],
                ..Default::default()
            }
        )
        .is_err()
    );
    let error = scan(
        dir.path(),
        &Options {
            scope: vec!["tests".into()],
            ..Default::default()
        },
    )
    .err()
    .unwrap()
    .to_string();
    assert!(error.contains("--include-tests"));
    assert!(error.contains("tests"));
}

#[test]
fn fixture_produces_type_and_callable_leads() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixture");
    let result = scan(&root, &Options::default()).unwrap();
    for (left, right) in [
        ("HttpOptions", "RpcOptions"),
        ("ReadStore", "FetchStore"),
        ("normalize_http", "normalize_rpc"),
    ] {
        assert!(
            result.candidates.iter().any(|pair| {
                let a = &result.declarations[&pair.left]["name"];
                let b = &result.declarations[&pair.right]["name"];
                (a == left && b == right) || (a == right && b == left)
            }),
            "missing {left}/{right}"
        );
    }
}

#[cfg(unix)]
#[test]
fn ancestor_manifest_symlinks_are_skipped_in_full_and_scoped_scans() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let manifest = outside.path().join("Cargo.toml");
    write(dir.path(), "src/lib.rs", "struct A { x: u8, y: u8 }");
    symlink(&manifest, dir.path().join("Cargo.toml")).unwrap();
    for contents in ["not valid TOML", "[package]\nedition='1900'\n"] {
        fs::write(&manifest, contents).unwrap();
        for scope in [vec![], vec!["src/lib.rs".into()]] {
            let result = scan(
                dir.path(),
                &Options {
                    scope,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(result.coverage.rust_file_count, 1);
            assert!(result.coverage.skipped_paths["symlink"].contains("Cargo.toml"));
            assert!(result.coverage.cargo_manifests.is_empty());
            assert!(result.coverage.module_gaps.iter().any(|gap| {
                gap["reason"]
                    .as_str()
                    .is_some_and(|reason| reason.contains("edition not resolved"))
            }));
        }
    }
}

#[test]
fn scoped_sources_resolve_editions_from_regular_ancestor_manifests() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "Cargo.toml",
        "[workspace.package]\nedition='2021'\n",
    );
    write(
        dir.path(),
        "member/Cargo.toml",
        "[package]\nname='member'\nedition.workspace=true\n",
    );
    write(dir.path(), "member/src/lib.rs", "struct A { x: u8, y: u8 }");
    let result = scan(
        dir.path(),
        &Options {
            scope: vec!["member/src/lib.rs".into()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(result.coverage.rust_file_count, 1);
    for manifest in ["Cargo.toml", "member/Cargo.toml"] {
        assert!(
            result
                .coverage
                .cargo_manifests
                .iter()
                .any(|p| p == manifest)
        );
    }
    assert!(!result.coverage.module_gaps.iter().any(|gap| {
        gap["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("edition not resolved"))
    }));
}
