use crate::repository::Report;
use std::fmt::Write;

fn cell(value: &str) -> String {
    value
        .replace('|', "\\|")
        .replace(['\n', '\r'], " ")
        .replace('`', "'")
}

pub fn markdown(report: &Report) -> String {
    let mut out = String::from("# Rust duplication candidates\n\n");
    let stats = &report.candidate_stats;
    writeln!(
        out,
        "{} Rust files; {} declarations; {} clusters.\n",
        report.coverage.rust_file_count,
        report.inventory["abstraction_count"],
        report.clusters.len()
    )
    .unwrap();
    writeln!(out, "{}\n", report.warning).unwrap();
    writeln!(out, "## Coverage\n\nPairs: {} potential, {} considered, {} prefiltered, {} not selected. Blocked groups: {}. Exact omitted: {}.\n", stats.potential_pairs, stats.pairs_considered, stats.pairs_prefiltered, stats.pairs_not_selected, stats.blocked_groups, stats.exact_omitted).unwrap();
    out.push_str("| Stream | Eligible | Emitted | Truncated | Lowest emitted score |\n| --- | ---: | ---: | ---: | ---: |\n");
    for (stream, counts) in &stats.by_stream {
        writeln!(
            out,
            "| {stream} | {} | {} | {} | {} |",
            counts.eligible,
            counts.emitted,
            counts.truncated,
            counts
                .lowest_emitted_score
                .map(|n| format!("{n:.4}"))
                .unwrap_or_else(|| "—".into())
        )
        .unwrap();
    }
    writeln!(
        out,
        "\nExcluded test items: {}.\n",
        report.coverage.skipped_item_count
    )
    .unwrap();
    for (reason, paths) in &report.coverage.skipped_paths {
        for path in paths {
            writeln!(out, "- {}: `{}`", cell(reason), cell(path)).unwrap();
        }
    }
    for (label, entries) in [
        ("Excluded items", &report.coverage.skipped_items),
        (
            "Parse errors (files excluded)",
            &report.coverage.parse_errors,
        ),
        (
            "Unresolved inherent impls",
            &report.coverage.unresolved_impls,
        ),
        ("Unexpanded item macros", &report.coverage.unexpanded_macros),
        ("Module/edition coverage gaps", &report.coverage.module_gaps),
    ] {
        if entries.is_empty() {
            continue;
        }
        writeln!(out, "\n### {label}\n").unwrap();
        for entry in entries {
            writeln!(out, "- {}", cell(&entry.to_string())).unwrap();
        }
    }
    out.push_str("\n## Clusters\n\n");
    for cluster in &report.clusters {
        writeln!(
            out,
            "### {} ({})\n\n{} eligible pairs; {} omitted from candidate output.\n",
            cluster.id, cluster.stream, cluster.eligible_pairs, cluster.omitted_pairs
        )
        .unwrap();
        for id in &cluster.members {
            if let Some(item) = report.declarations.get(id) {
                writeln!(
                    out,
                    "- `{}` — {}:{}:{}",
                    cell(item["name"].as_str().unwrap_or("")),
                    cell(item["file"].as_str().unwrap_or("")),
                    item["line"],
                    item["column"]
                )
                .unwrap();
            }
        }
        out.push('\n');
    }
    out.push_str("## Candidate edges\n\n");
    if report.candidates.is_empty() {
        out.push_str("No candidates met the configured threshold. Check coverage before drawing conclusions.\n");
    }
    for candidate in &report.candidates {
        writeln!(
            out,
            "### {} — {:.4}{}\n\n- `{}`\n- `{}`\n",
            candidate.id,
            candidate.score,
            if candidate.exact {
                " (mechanically exact)"
            } else {
                ""
            },
            cell(&candidate.left),
            cell(&candidate.right)
        )
        .unwrap();
        for divergence in &candidate.divergences {
            writeln!(out, "- {}", cell(divergence)).unwrap();
        }
        writeln!(
            out,
            "\nSignals: {}\n",
            candidate
                .signals
                .iter()
                .map(|(k, v)| format!("{k}={v:.3}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
        .unwrap();
    }
    out
}
