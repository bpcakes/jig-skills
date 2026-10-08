use rust_dup_unifier::{
    compare::{self, blocked_pairs},
    model::Declaration,
};
use std::collections::{BTreeMap, BTreeSet};

fn record(name: &str, line: usize) -> Declaration {
    Declaration {
        kind: "struct".into(),
        name: name.into(),
        file: "lib.rs".into(),
        line,
        column: 1,
        shape: "record".into(),
        header: "struct $name".into(),
        members: BTreeMap::from([
            ("id".into(), "u64".into()),
            ("name".into(), "String".into()),
        ]),
        ..Default::default()
    }
}

fn function(name: &str, line: usize) -> Declaration {
    Declaration {
        kind: "function".into(),
        name: name.into(),
        file: "lib.rs".into(),
        line,
        column: 1,
        signature: "fn $name (_ : u32) -> u32".into(),
        body_tokens: "{ let $id = $id + $literal ; $id * $id }"
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        ..Default::default()
    }
}

#[test]
fn stream_caps_do_not_hide_cluster_members_or_exact_pairs() {
    let items = vec![
        record("Alpha", 1),
        record("Beta", 2),
        record("Gamma", 3),
        function("first", 4),
        function("second", 5),
        function("third", 6),
    ];
    let (pairs, stats, clusters) = compare::generate(&items, 0.68, 1, true);
    assert_eq!(pairs.len(), 2);
    assert_eq!(stats.eligible, 6);
    assert_eq!(stats.truncated, 4);
    assert_eq!(clusters.len(), 2);
    for stream in ["types", "callables"] {
        assert_eq!(stats.by_stream[stream].emitted, 1);
        assert_eq!(stats.by_stream[stream].truncated, 2);
    }
    for cluster in &clusters {
        assert_eq!(cluster.members.len(), 3);
        assert_eq!(cluster.omitted_pairs, 2);
        assert_eq!(cluster.candidate_ids.len(), 1);
    }
    assert!(pairs.iter().all(|p| p.exact));
    let (none, stats, _) = compare::generate(&items, 0.68, 100, false);
    assert!(none.is_empty());
    assert_eq!(stats.exact_omitted, 6);
}

#[test]
fn blocking_is_deterministic_and_reports_missing_comparisons() {
    let mut items: Vec<_> = (0..720)
        .map(|i| function(&format!("fn_{i}"), i + 1))
        .collect();
    items[5].calls.insert("rare_pair".into());
    items[710].calls.insert("rare_pair".into());
    let refs: Vec<_> = items.iter().collect();
    let selected = blocked_pairs(&refs);
    assert!(selected.contains(&(5, 710)));
    assert_eq!(selected, blocked_pairs(&refs));
    let (_, stats, _) = compare::generate(&items, 0.68, 1, true);
    assert_eq!(stats.blocked_groups, 1);
    assert!(stats.pairs_not_selected > 0);
    assert_eq!(
        stats.potential_pairs,
        stats.pairs_selected + stats.pairs_not_selected
    );
    assert_eq!(
        stats.pairs_selected,
        stats.pairs_considered + stats.pairs_prefiltered
    );
}

#[test]
fn different_calls_and_literals_prevent_exactness() {
    let a = function("first", 1);
    let mut b = function("second", 2);
    b.calls = BTreeSet::from(["different".into()]);
    b.literals = vec!["42".into()];
    assert!(!compare::compare(&a, &b).unwrap().exact);
}
