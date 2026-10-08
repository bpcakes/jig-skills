use crate::{
    compare::{self, CandidateStats, Cluster},
    extract,
    model::{Candidate, Coverage},
};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ra_ap_syntax::{AstNode, Edition, SourceFile, SyntaxKind, ast};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Debug, Serialize)]
pub struct Options {
    pub scope: Vec<PathBuf>,
    pub min_score: f64,
    pub max_candidates: usize,
    pub include_tests: bool,
    pub include_generated: bool,
    pub include_exact: bool,
    pub exclude: Vec<String>,
    pub details: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            scope: vec![],
            min_score: 0.68,
            max_candidates: 100,
            include_tests: false,
            include_generated: false,
            include_exact: true,
            exclude: vec![],
            details: false,
        }
    }
}

#[derive(Serialize)]
pub struct Report {
    pub tool: &'static str,
    pub version: u8,
    pub root: String,
    pub settings: Value,
    pub coverage: Coverage,
    pub inventory: Value,
    pub candidate_stats: CandidateStats,
    pub declarations: BTreeMap<String, Value>,
    pub clusters: Vec<Cluster>,
    pub candidates: Vec<Candidate>,
    pub warning: &'static str,
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn excluded(root: &Path, path: &Path, options: &Options, globs: &GlobSet) -> Option<&'static str> {
    let relative = relative(root, path);
    if relative.split('/').any(|part| {
        matches!(
            part,
            ".git"
                | ".hg"
                | ".svn"
                | ".cargo"
                | "target"
                | "node_modules"
                | "vendor"
                | "third_party"
                | "dist"
        )
    }) {
        return Some("default_directory");
    }
    if !options.include_tests
        && relative
            .split('/')
            .any(|part| matches!(part, "tests" | "test" | "benches" | "examples" | "fixtures"))
    {
        return Some("test_path");
    }
    if globs.is_match(&relative) {
        return Some("user_glob");
    }
    None
}

fn discover(
    root: &Path,
    path: &Path,
    options: &Options,
    globs: &GlobSet,
    visited: &mut BTreeSet<PathBuf>,
    files: &mut BTreeSet<PathBuf>,
    coverage: &mut Coverage,
) -> Result<()> {
    if let Some(reason) = excluded(root, path, options, globs) {
        coverage.skip(reason, &relative(root, path));
        return Ok(());
    }
    // Do not follow symlinks: aliases otherwise duplicate declarations or escape scope.
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        coverage.skip("symlink", &relative(root, path));
        return Ok(());
    }
    if !visited.insert(path.to_owned()) {
        return Ok(());
    }
    if path.is_dir() {
        let mut entries: Vec<_> = fs::read_dir(path)?
            .map(|e| e.map(|e| e.path()))
            .collect::<std::io::Result<_>>()?;
        entries.sort();
        for entry in entries {
            discover(root, &entry, options, globs, visited, files, coverage)?;
        }
    } else if path.extension().is_some_and(|s| s == "rs") {
        files.insert(path.to_owned());
    } else if path.file_name().is_some_and(|s| s == "Cargo.toml") {
        coverage.cargo_manifests.push(relative(root, path));
    }
    Ok(())
}

fn edition_for(file: &Path, root: &Path, coverage: &mut Coverage) -> Result<Edition> {
    let mut found = None;
    for directory in file
        .parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .take_while(|p| p.starts_with(root))
    {
        let manifest = directory.join("Cargo.toml");
        let metadata = match fs::symlink_metadata(&manifest) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            coverage.skip("symlink", &relative(root, &manifest));
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if !manifest.canonicalize()?.starts_with(root) {
            coverage.skip("outside_repository", &relative(root, &manifest));
            continue;
        }
        coverage.cargo_manifests.push(relative(root, &manifest));
        let document: toml::Value = fs::read_to_string(&manifest)?.parse()?;
        if found.is_none() {
            if document
                .get("package")
                .is_some_and(|package| package.get("edition").is_none())
            {
                return Ok(Edition::Edition2015);
            }
            found = document
                .get("package")
                .and_then(|v| v.get("edition"))
                .cloned();
        }
        let inherited = found
            .as_ref()
            .is_some_and(|v| v.get("workspace").and_then(toml::Value::as_bool) == Some(true));
        if inherited {
            if let Some(value) = document
                .get("workspace")
                .and_then(|v| v.get("package"))
                .and_then(|v| v.get("edition"))
            {
                found = Some(value.clone());
            }
        }
        if let Some(edition) = found.as_ref().and_then(toml::Value::as_str) {
            return edition
                .parse::<Edition>()
                .map_err(|e| format!("{}: {e}", manifest.display()).into());
        }
    }
    // With no declared edition, use the parser's current edition and expose this assumption.
    coverage.module_gaps.push(json!({"file":relative(root,file), "reason":"edition not resolved within scan root; parsed as Rust 2024"}));
    Ok(Edition::Edition2024)
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Context {
    crate_root: String,
    module: Vec<String>,
    test_only: bool,
}

struct ModuleEdge {
    target: PathBuf,
    module: Vec<String>,
    test_only: bool,
}

fn module_edges(
    file: &Path,
    source: &str,
    edition: Edition,
    sources: &BTreeMap<PathBuf, (String, Edition)>,
    root: &Path,
    coverage: &mut Coverage,
) -> Vec<ModuleEdge> {
    let parsed = SourceFile::parse(source, edition);
    if !parsed.errors().is_empty() {
        return vec![];
    }
    let tree = parsed.tree();
    let mut result = Vec::new();
    for module in tree.syntax().descendants().filter_map(ast::Module::cast) {
        if module
            .syntax()
            .children()
            .any(|n| n.kind() == SyntaxKind::ITEM_LIST)
        {
            continue;
        }
        if module
            .syntax()
            .ancestors()
            .any(|n| matches!(n.kind(), SyntaxKind::FN | SyntaxKind::TOKEN_TREE))
        {
            continue;
        }
        let names: Vec<_> = module
            .syntax()
            .ancestors()
            .filter_map(ast::Module::cast)
            .filter_map(|m| {
                m.syntax().children().find_map(ast::Name::cast).map(|n| {
                    n.syntax()
                        .text()
                        .to_string()
                        .trim_start_matches("r#")
                        .to_owned()
                })
            })
            .collect();
        let names: Vec<_> = names.into_iter().rev().collect();
        let Some(name) = names.last() else {
            continue;
        };
        let mut directory = file.parent().unwrap().to_owned();
        if !matches!(
            file.file_name().and_then(|s| s.to_str()),
            Some("lib.rs" | "main.rs" | "mod.rs")
        ) {
            directory.push(file.file_stem().unwrap());
        }
        for inline in &names[..names.len() - 1] {
            directory.push(inline);
        }
        let mut path_override = None;
        let mut unsupported = false;
        for ancestor in module
            .syntax()
            .ancestors()
            .filter(|n| matches!(n.kind(), SyntaxKind::MODULE))
        {
            for attr in ancestor.children().filter_map(ast::Attr::cast) {
                let tokens: Vec<_> = attr
                    .syntax()
                    .descendants_with_tokens()
                    .filter_map(|e| e.into_token())
                    .filter(|t| !t.kind().is_trivia())
                    .collect();
                if !tokens.iter().any(|t| t.text() == "path") {
                    continue;
                }
                if ancestor != *module.syntax() || tokens.get(2).is_none_or(|t| t.text() != "path")
                {
                    unsupported = true;
                    continue;
                }
                path_override = tokens
                    .iter()
                    .find(|t| t.kind() == SyntaxKind::STRING)
                    .and_then(|t| serde_json::from_str::<String>(t.text()).ok());
                if path_override.is_none() {
                    unsupported = true;
                }
            }
        }
        let possible = if let Some(path) = path_override {
            let mut base = file.parent().unwrap().to_owned();
            for inline in &names[..names.len() - 1] {
                base.push(inline);
            }
            vec![base.join(path)]
        } else {
            vec![
                directory.join(format!("{name}.rs")),
                directory.join(name).join("mod.rs"),
            ]
        };
        let possible: BTreeSet<_> = possible
            .into_iter()
            .filter_map(|p| p.canonicalize().ok())
            .filter(|p| sources.contains_key(p))
            .collect();
        if unsupported || possible.len() != 1 {
            coverage.module_gaps.push(json!({"file":relative(root,file), "module":names, "reason":"module path unsupported, ambiguous, missing, or outside selected files"}));
            continue;
        }
        result.push(ModuleEdge {
            target: possible.into_iter().next().unwrap(),
            module: names,
            test_only: extract::test_only(module.syntax()),
        });
    }
    result
}

fn contexts(
    sources: &BTreeMap<PathBuf, (String, Edition)>,
    root: &Path,
    coverage: &mut Coverage,
) -> BTreeMap<PathBuf, BTreeSet<Context>> {
    let edges: BTreeMap<_, _> = sources
        .iter()
        .map(|(file, (source, edition))| {
            (
                file.clone(),
                module_edges(file, source, *edition, sources, root, coverage),
            )
        })
        .collect();
    let referenced: BTreeSet<_> = edges.values().flatten().map(|e| e.target.clone()).collect();
    let mut result: BTreeMap<PathBuf, BTreeSet<Context>> = BTreeMap::new();
    let mut queue = Vec::new();
    for file in sources.keys().filter(|p| !referenced.contains(*p)) {
        queue.push((
            file.clone(),
            Context {
                crate_root: relative(root, file),
                module: vec![],
                test_only: false,
            },
            BTreeSet::new(),
        ));
    }
    while let Some((file, context, mut ancestry)) = queue.pop() {
        if !ancestry.insert(file.clone()) {
            coverage
                .module_gaps
                .push(json!({"file":relative(root,&file), "reason":"cyclic module inclusion"}));
            continue;
        }
        if !result
            .entry(file.clone())
            .or_default()
            .insert(context.clone())
        {
            continue;
        }
        for edge in &edges[&file] {
            let mut next = context.clone();
            next.module.extend(edge.module.clone());
            next.test_only |= edge.test_only;
            queue.push((edge.target.clone(), next, ancestry.clone()));
        }
    }
    for file in sources.keys() {
        if !result.contains_key(file) {
            coverage.module_gaps.push(json!({"file":relative(root,file), "reason":"module context unresolved; scanned in isolation"}));
            result.insert(
                file.clone(),
                BTreeSet::from([Context {
                    crate_root: relative(root, file),
                    module: vec![],
                    test_only: false,
                }]),
            );
        }
    }
    result
}

pub fn scan(root: &Path, options: &Options) -> Result<Report> {
    if !options.min_score.is_finite()
        || !(0.0..=1.0).contains(&options.min_score)
        || options.max_candidates == 0
    {
        return Err("invalid score or candidate limit".into());
    }
    let root = root.canonicalize()?;
    if !root.is_dir() {
        return Err("repository root must be a directory".into());
    }
    let mut builder = GlobSetBuilder::new();
    for pattern in &options.exclude {
        builder.add(Glob::new(pattern)?);
    }
    let globs = builder.build()?;
    let mut coverage = Coverage::default();
    let mut files = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let scopes = if options.scope.is_empty() {
        vec![PathBuf::from(".")]
    } else {
        options.scope.clone()
    };
    for scope in scopes {
        if scope.is_absolute()
            || scope
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!(
                "scope must be repository-relative without '..': {}",
                scope.display()
            )
            .into());
        }
        let path = root.join(scope);
        if !path.canonicalize()?.starts_with(&root) {
            return Err(format!("scope escapes repository: {}", path.display()).into());
        }
        discover(
            &root,
            &path,
            options,
            &globs,
            &mut visited,
            &mut files,
            &mut coverage,
        )?;
    }
    let mut sources = BTreeMap::new();
    for file in files {
        let edition = edition_for(&file, &root, &mut coverage)?;
        let source = fs::read_to_string(&file)?;
        if !options.include_generated
            && extract::generated_file(
                &source,
                &file.file_name().unwrap().to_string_lossy(),
                edition,
            )
        {
            coverage.skip("generated_file", &relative(&root, &file));
            continue;
        }
        sources.insert(file.canonicalize()?, (source, edition));
    }
    if sources.is_empty() {
        return Err(format!("No Rust source files found after exclusions. Check --scope, --exclude, --include-tests and --include-generated. Skipped paths: {}", serde_json::to_string(&coverage.skipped_paths)?).into());
    }
    let contexts = contexts(&sources, &root, &mut coverage);
    let mut items = Vec::new();
    for (file, (source, edition)) in sources {
        let available: Vec<_> = contexts[&file]
            .iter()
            .filter(|c| options.include_tests || !c.test_only)
            .collect();
        if available.is_empty() {
            coverage.skip("test_module", &relative(&root, &file));
            continue;
        }
        let context = if available.len() == 1 {
            available[0].clone()
        } else {
            coverage.module_gaps.push(json!({"file":relative(&root,&file), "reason":"file included in multiple module contexts; method attachment isolated"}));
            Context {
                crate_root: relative(&root, &file),
                module: vec![],
                test_only: false,
            }
        };
        let name = relative(&root, &file);
        coverage.rust_files.push(name.clone());
        items.extend(extract::parse_file(
            &source,
            &name,
            &context.crate_root,
            &context.module,
            edition,
            options.include_tests,
            &mut coverage,
        ));
    }
    coverage.rust_file_count = coverage.rust_files.len();
    coverage.cargo_manifests.sort();
    coverage.cargo_manifests.dedup();
    coverage.skipped = coverage
        .skipped_paths
        .iter()
        .map(|(reason, paths)| (reason.clone(), paths.len()))
        .collect();
    extract::attach_methods(&mut items, &mut coverage);
    items.sort_by_key(|item| item.id());
    let (candidates, candidate_stats, clusters) = compare::generate(
        &items,
        options.min_score,
        options.max_candidates,
        options.include_exact,
    );
    let referenced: BTreeSet<_> = clusters
        .iter()
        .flat_map(|c| c.members.iter().cloned())
        .collect();
    let declarations = items
        .iter()
        .filter(|item| options.details || referenced.contains(&item.id()))
        .map(|item| (item.id(), item.summary(options.details)))
        .collect();
    let mut kinds = BTreeMap::<String, usize>::new();
    for item in &items {
        *kinds.entry(item.kind.clone()).or_default() += 1;
    }
    Ok(Report {
        tool: "rust-dup-unifier",
        version: 3,
        root: root.to_string_lossy().into(),
        settings: serde_json::to_value(options)?,
        coverage,
        inventory: json!({"abstraction_count":items.len(),"by_kind":kinds}),
        candidate_stats,
        declarations,
        clusters,
        candidates,
        warning: "Syntax similarity is a lead, not semantic equivalence. No macro expansion, import/type resolution, or full cfg evaluation is performed. Module roots are inferred within selected files, not from Cargo's target graph.",
    })
}
