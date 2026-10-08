use crate::model::{Candidate, Declaration, stable_hash};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

fn overlap<T: Ord>(a: &BTreeSet<T>, b: &BTreeSet<T>) -> f64 {
    let union = a.union(b).count();
    if union == 0 {
        1.0
    } else {
        a.intersection(b).count() as f64 / union as f64
    }
}

fn keys(map: &BTreeMap<String, String>) -> BTreeSet<String> {
    map.keys().cloned().collect()
}

fn shingles(tokens: &[String], size: usize) -> BTreeSet<String> {
    if tokens.is_empty() {
        return BTreeSet::new();
    }
    tokens
        .windows(size.min(tokens.len()))
        .map(|part| part.join("\x1f"))
        .collect()
}

// Character bigrams keep shape comparisons bounded in both time and memory.
fn similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    let grams = |s: &str| shingles(&s.chars().map(|c| c.to_string()).collect::<Vec<_>>(), 2);
    overlap(&grams(a), &grams(b))
}

fn shared_shape(a: &BTreeMap<String, String>, b: &BTreeMap<String, String>) -> f64 {
    let values: Vec<_> = a
        .iter()
        .filter_map(|(key, value)| b.get(key).map(|other| similarity(value, other)))
        .collect();
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn weighted(parts: &[(f64, f64)]) -> f64 {
    let total: f64 = parts.iter().map(|(_, weight)| weight).sum();
    parts
        .iter()
        .map(|(value, weight)| value * weight)
        .sum::<f64>()
        / total
}

fn short_list(values: impl Iterator<Item = String>) -> String {
    let values: Vec<_> = values.collect();
    let mut result = values
        .iter()
        .take(8)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if values.len() > 8 {
        result.push_str(&format!(", … (+{})", values.len() - 8));
    }
    result
}

fn mapping_diff(
    label: &str,
    a: &BTreeMap<String, String>,
    b: &BTreeMap<String, String>,
    out: &mut Vec<String>,
) {
    let left = keys(a);
    let right = keys(b);
    for (side, only) in [
        ("left", left.difference(&right).cloned().collect::<Vec<_>>()),
        ("right", right.difference(&left).cloned().collect()),
    ] {
        if !only.is_empty() {
            out.push(format!(
                "{label} only on {side}: {}",
                short_list(only.into_iter())
            ));
        }
    }
    let changed: Vec<_> = left
        .intersection(&right)
        .filter(|key| a[*key] != b[*key])
        .cloned()
        .collect();
    if !changed.is_empty() {
        out.push(format!(
            "Changed {label}: {}",
            short_list(changed.into_iter())
        ));
    }
}

pub fn compare(a: &Declaration, b: &Declaration) -> Option<Candidate> {
    if a.kind != b.kind && !(a.callable() && b.callable()) {
        return None;
    }
    let mut signals = BTreeMap::new();
    let mut divergences = Vec::new();
    let names = similarity(
        a.name.rsplit("::").next().unwrap(),
        b.name.rsplit("::").next().unwrap(),
    );
    signals.insert("name_similarity".into(), names);
    let score;
    let mut exact;
    let rationale;
    if a.callable() {
        let shorter = a.body_tokens.len().min(b.body_tokens.len());
        let longer = a.body_tokens.len().max(b.body_tokens.len());
        if shorter < 10 || shorter as f64 / (longer as f64) < 0.45 {
            return None;
        }
        let body = overlap(&shingles(&a.body_tokens, 5), &shingles(&b.body_tokens, 5));
        let signature = similarity(&a.signature, &b.signature);
        let calls = overlap(&a.calls, &b.calls);
        let literals = overlap(
            &a.literals.iter().cloned().collect(),
            &b.literals.iter().cloned().collect(),
        );
        score = weighted(&[
            (body, 0.50),
            (signature, 0.24),
            (
                calls,
                if a.calls.is_empty() && b.calls.is_empty() {
                    0.0
                } else {
                    0.15
                },
            ),
            (
                literals,
                if a.literals.is_empty() && b.literals.is_empty() {
                    0.0
                } else {
                    0.08
                },
            ),
            (names, 0.08),
        ]);
        if (shorter <= 20 && body < 0.80) || (body < 0.35 && score < 0.75) {
            return None;
        }
        exact = a.signature == b.signature
            && a.body_tokens == b.body_tokens
            && a.literals == b.literals
            && a.calls == b.calls;
        for (label, different) in [
            ("Signature shapes", a.signature != b.signature),
            ("Body shapes", a.body_tokens != b.body_tokens),
            ("Calls", a.calls != b.calls),
            ("Literals", a.literals != b.literals),
        ] {
            if different {
                divergences.push(format!("{label} differ."));
            }
        }
        signals.extend([
            ("body_shingle_overlap".into(), body),
            ("signature_similarity".into(), signature),
            ("call_overlap".into(), calls),
            ("literal_overlap".into(), literals),
        ]);
        rationale = "normalized body and callable signature similarity";
    } else if a.kind == "type_alias" {
        let target = similarity(a.members.get("target")?, b.members.get("target")?);
        if target < 0.65 {
            return None;
        }
        score = 0.85 * target + 0.15 * names;
        exact = a.members == b.members;
        signals.insert("target_similarity".into(), target);
        rationale = "similar alias targets";
    } else if a.kind == "trait" {
        let methods = overlap(&keys(&a.methods), &keys(&b.methods));
        let method_shape = shared_shape(&a.methods, &b.methods);
        let assoc = overlap(&keys(&a.members), &keys(&b.members));
        let assoc_shape = shared_shape(&a.members, &b.members);
        if keys(&a.methods).union(&keys(&b.methods)).count()
            + keys(&a.members).union(&keys(&b.members)).count()
            < 2
        {
            return None;
        }
        if methods < 0.3 && assoc < 0.5 {
            return None;
        }
        score = weighted(&[
            (methods, 0.46),
            (
                method_shape,
                if a.methods.keys().any(|k| b.methods.contains_key(k)) {
                    0.30
                } else {
                    0.0
                },
            ),
            (
                assoc,
                if a.members.is_empty() && b.members.is_empty() {
                    0.0
                } else {
                    0.10
                },
            ),
            (
                assoc_shape,
                if a.members.keys().any(|k| b.members.contains_key(k)) {
                    0.06
                } else {
                    0.0
                },
            ),
            (names, 0.08),
        ]);
        exact = a.methods == b.methods && a.members == b.members;
        signals.extend([
            ("method_name_overlap".into(), methods),
            ("shared_method_shape".into(), method_shape),
            ("associated_item_overlap".into(), assoc),
        ]);
        rationale = "combined trait surface similarity";
    } else {
        if (a.shape == "tuple" || b.shape == "tuple") && a.members.len().min(b.members.len()) <= 1 {
            return None;
        }
        let left = keys(&a.members);
        let right = keys(&b.members);
        if left.union(&right).count() < 2 && keys(&a.methods).union(&keys(&b.methods)).count() < 2 {
            return None;
        }
        let named = |keys: &BTreeSet<String>| {
            keys.iter()
                .filter(|key| key.parse::<usize>().is_err())
                .cloned()
                .collect::<BTreeSet<_>>()
        };
        let has_names = !named(&left).is_empty() || !named(&right).is_empty();
        let member_names = if has_names {
            overlap(&named(&left), &named(&right))
        } else {
            0.0
        };
        let shape = shared_shape(&a.members, &b.members);
        let types = overlap(
            &a.members.values().cloned().collect(),
            &b.members.values().cloned().collect(),
        );
        let methods = overlap(&keys(&a.methods), &keys(&b.methods));
        if member_names < 0.25 && types < 0.45 && methods < 0.5 {
            return None;
        }
        score = weighted(&[
            (member_names, if has_names { 0.42 } else { 0.0 }),
            (
                shape,
                if left.intersection(&right).next().is_some() {
                    0.24
                } else {
                    0.0
                },
            ),
            (types, 0.10),
            (
                methods,
                if a.methods.is_empty() && b.methods.is_empty() {
                    0.0
                } else {
                    0.10
                },
            ),
            (
                shared_shape(&a.methods, &b.methods),
                if a.methods.keys().any(|key| b.methods.contains_key(key)) {
                    0.08
                } else {
                    0.0
                },
            ),
            (names, 0.06),
        ]);
        exact = a.members == b.members && a.methods == b.methods && a.shape == b.shape;
        signals.extend([
            ("member_name_overlap".into(), member_names),
            ("shared_member_shape".into(), shape),
            ("member_type_overlap".into(), types),
            ("method_name_overlap".into(), methods),
        ]);
        rationale = "combined structural similarity";
    }
    mapping_diff("members", &a.members, &b.members, &mut divergences);
    mapping_diff("methods", &a.methods, &b.methods, &mut divergences);
    for (label, different) in [
        ("Visibility", a.visibility != b.visibility),
        ("Attributes", a.attributes != b.attributes),
        (
            "Member visibility/attributes",
            a.member_contracts != b.member_contracts,
        ),
        ("Declaration bounds/header", a.header != b.header),
    ] {
        if different {
            exact = false;
            divergences.push(format!("{label} differ."));
        }
    }
    if divergences.is_empty() {
        divergences.push("No mechanical divergence found.".into());
    }
    let mut ids = [a.id(), b.id()];
    ids.sort();
    Some(Candidate {
        id: format!("DU-CAND-{}", stable_hash(&ids.join("|"))),
        stream: a.stream().into(),
        left: a.id(),
        right: b.id(),
        score: (score * 10000.0).round() / 10000.0,
        exact,
        signals,
        divergences,
        rationale: vec![rationale.into()],
    })
}

#[derive(Debug, Default, Serialize)]
pub struct CandidateStats {
    pub potential_pairs: usize,
    pub pairs_selected: usize,
    pub pairs_considered: usize,
    pub pairs_prefiltered: usize,
    pub pairs_not_selected: usize,
    pub below_threshold: usize,
    pub exact_omitted: usize,
    pub blocked_groups: usize,
    pub eligible: usize,
    pub emitted: usize,
    pub truncated: usize,
    pub by_stream: BTreeMap<String, StreamStats>,
}

#[derive(Debug, Serialize)]
pub struct StreamStats {
    pub eligible: usize,
    pub emitted: usize,
    pub truncated: usize,
    pub lowest_emitted_score: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct Cluster {
    pub id: String,
    pub stream: String,
    pub members: Vec<String>,
    pub eligible_pairs: usize,
    pub candidate_ids: Vec<String>,
    pub omitted_pairs: usize,
    pub max_score: f64,
}

fn features(item: &Declaration) -> BTreeSet<String> {
    let mut result = BTreeSet::new();
    for (name, shape) in &item.members {
        if name.parse::<usize>().is_err() {
            result.insert(format!("member:{name}"));
        }
        result.insert(format!("shape:{shape}"));
    }
    for (name, shape) in &item.methods {
        result.insert(format!("method:{name}"));
        result.insert(format!("signature:{shape}"));
    }
    if item.callable() {
        result.extend(
            shingles(&item.body_tokens, 5)
                .into_iter()
                .map(|s| format!("body:{}", stable_hash(&s))),
        );
        result.extend(item.calls.iter().map(|s| format!("call:{s}")));
    }
    result
}

pub fn blocked_pairs(items: &[&Declaration]) -> BTreeSet<(usize, usize)> {
    let sets: Vec<_> = items.iter().map(|item| features(item)).collect();
    let mut frequency = BTreeMap::<&str, usize>::new();
    for set in &sets {
        for feature in set {
            *frequency.entry(feature).or_default() += 1;
        }
    }
    let mut buckets = BTreeMap::<&str, Vec<usize>>::new();
    for (index, set) in sets.iter().enumerate() {
        let mut rare: Vec<_> = set
            .iter()
            .filter(|s| (2..=96).contains(&frequency[s.as_str()]))
            .collect();
        rare.sort_by_key(|s| (frequency[s.as_str()], *s));
        for feature in rare.into_iter().take(12) {
            buckets.entry(feature).or_default().push(index);
        }
    }
    let mut pairs = BTreeSet::new();
    for bucket in buckets.values() {
        for (pos, &a) in bucket.iter().enumerate() {
            for &b in &bucket[pos + 1..] {
                pairs.insert((a.min(b), a.max(b)));
            }
        }
    }
    let mut order: Vec<_> = (0..items.len()).collect();
    order.sort_by_key(|&i| {
        (
            items[i].body_tokens.len(),
            items[i].members.len(),
            items[i].methods.len(),
            items[i].id(),
        )
    });
    for (pos, &a) in order.iter().enumerate() {
        for &b in &order[pos + 1..(pos + 19).min(order.len())] {
            pairs.insert((a.min(b), a.max(b)));
        }
    }
    pairs
}

pub fn generate(
    items: &[Declaration],
    minimum: f64,
    maximum: usize,
    include_exact: bool,
) -> (Vec<Candidate>, CandidateStats, Vec<Cluster>) {
    let mut groups = BTreeMap::<&str, Vec<&Declaration>>::new();
    for item in items {
        groups
            .entry(if item.callable() {
                "callable"
            } else {
                &item.kind
            })
            .or_default()
            .push(item);
    }
    let mut stats = CandidateStats::default();
    let mut eligible = Vec::new();
    for (kind, group) in groups {
        let size = group.len();
        stats.potential_pairs += size * size.saturating_sub(1) / 2;
        let limit = if kind == "callable" { 700 } else { 500 };
        let pairs: Box<dyn Iterator<Item = (usize, usize)>> = if size <= limit {
            Box::new((0..size).flat_map(move |a| (a + 1..size).map(move |b| (a, b))))
        } else {
            stats.blocked_groups += 1;
            Box::new(blocked_pairs(&group).into_iter())
        };
        for (a, b) in pairs {
            stats.pairs_selected += 1;
            let (a, b) = (group[a], group[b]);
            if a.callable()
                && (a.body_tokens.is_empty()
                    || b.body_tokens.is_empty()
                    || a.body_tokens.len().min(b.body_tokens.len()) as f64
                        / (a.body_tokens.len().max(b.body_tokens.len()) as f64)
                        < 0.45)
            {
                stats.pairs_prefiltered += 1;
                continue;
            }
            stats.pairs_considered += 1;
            match compare(a, b) {
                Some(candidate) if candidate.score >= minimum => {
                    if candidate.exact && !include_exact {
                        stats.exact_omitted += 1;
                    } else {
                        eligible.push(candidate);
                    }
                }
                _ => stats.below_threshold += 1,
            }
        }
    }
    eligible.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
    let mut emitted = Vec::new();
    for stream in ["types", "callables"] {
        let group: Vec<_> = eligible.iter().filter(|c| c.stream == stream).collect();
        let selected: Vec<_> = group.iter().take(maximum).map(|c| (**c).clone()).collect();
        stats.by_stream.insert(
            stream.into(),
            StreamStats {
                eligible: group.len(),
                emitted: selected.len(),
                truncated: group.len() - selected.len(),
                lowest_emitted_score: selected.last().map(|c| c.score),
            },
        );
        emitted.extend(selected);
    }
    stats.eligible = eligible.len();
    stats.emitted = emitted.len();
    stats.truncated = eligible.len() - emitted.len();
    stats.pairs_not_selected = stats.potential_pairs - stats.pairs_selected;
    let clusters = clusters(&eligible, &emitted.iter().map(|c| c.id.clone()).collect());
    (emitted, stats, clusters)
}

fn clusters(candidates: &[Candidate], emitted: &BTreeSet<String>) -> Vec<Cluster> {
    let mut adjacency = BTreeMap::<String, BTreeSet<String>>::new();
    for edge in candidates {
        adjacency
            .entry(edge.left.clone())
            .or_default()
            .insert(edge.right.clone());
        adjacency
            .entry(edge.right.clone())
            .or_default()
            .insert(edge.left.clone());
    }
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for start in adjacency.keys() {
        if seen.contains(start) {
            continue;
        }
        let mut members = BTreeSet::new();
        let mut queue = vec![start.clone()];
        while let Some(node) = queue.pop() {
            if !seen.insert(node.clone()) {
                continue;
            }
            queue.extend(adjacency[&node].iter().cloned());
            members.insert(node);
        }
        let edges: Vec<_> = candidates
            .iter()
            .filter(|edge| members.contains(&edge.left))
            .collect();
        let ids: Vec<_> = edges
            .iter()
            .filter(|edge| emitted.contains(&edge.id))
            .map(|edge| edge.id.clone())
            .collect();
        result.push(Cluster {
            id: format!(
                "DU-GROUP-{}",
                stable_hash(&members.iter().cloned().collect::<Vec<_>>().join("|"))
            ),
            stream: edges[0].stream.clone(),
            members: members.into_iter().collect(),
            eligible_pairs: edges.len(),
            omitted_pairs: edges.len() - ids.len(),
            candidate_ids: ids,
            max_score: edges.iter().map(|edge| edge.score).fold(0.0, f64::max),
        });
    }
    result.sort_by(|a, b| {
        a.stream
            .cmp(&b.stream)
            .then_with(|| b.max_score.total_cmp(&a.max_score))
            .then_with(|| a.id.cmp(&b.id))
    });
    result
}
