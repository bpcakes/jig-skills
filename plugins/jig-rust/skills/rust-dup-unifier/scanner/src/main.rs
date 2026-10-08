use clap::{Parser, ValueEnum};
use rust_dup_unifier::{
    report,
    repository::{Options, scan},
};
use std::{
    io::{self, Write},
    path::PathBuf,
};

#[derive(Clone, Copy, ValueEnum)]
enum Format {
    Json,
    Markdown,
}

#[derive(Parser)]
#[command(
    version,
    about = "Find candidate Rust duplication with rust-analyzer syntax trees"
)]
struct Cli {
    #[arg(default_value = ".")]
    root: PathBuf,
    #[arg(long)]
    scope: Vec<PathBuf>,
    #[arg(long, default_value = "0.68", value_parser = score)]
    min_score: f64,
    /// Maximum emitted pairs per stream (types and callables).
    #[arg(long, default_value = "100", value_parser = positive)]
    max_candidates: usize,
    #[arg(long)]
    include_tests: bool,
    #[arg(long)]
    include_generated: bool,
    /// Exact matches are included by default; retained for compatibility.
    #[arg(long, conflicts_with = "exclude_exact")]
    include_exact: bool,
    #[arg(long)]
    exclude_exact: bool,
    #[arg(long)]
    exclude: Vec<String>,
    #[arg(long)]
    details: bool,
    #[arg(long, value_enum, default_value = "markdown")]
    format: Format,
    #[arg(short, long)]
    output: Option<PathBuf>,
}

fn score(value: &str) -> Result<f64, String> {
    let number: f64 = value.parse().map_err(|_| "expected a number from 0 to 1")?;
    if number.is_finite() && (0.0..=1.0).contains(&number) {
        Ok(number)
    } else {
        Err("expected a number from 0 to 1".into())
    }
}

fn positive(value: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .ok()
        .filter(|&n| n > 0)
        .ok_or_else(|| "expected a positive integer".into())
}

fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let result = scan(
        &cli.root,
        &Options {
            scope: cli.scope,
            min_score: cli.min_score,
            max_candidates: cli.max_candidates,
            include_tests: cli.include_tests,
            include_generated: cli.include_generated,
            include_exact: !cli.exclude_exact,
            exclude: cli.exclude,
            details: cli.details,
        },
    )?;
    let content = match cli.format {
        Format::Json => serde_json::to_string(&result)? + "\n",
        Format::Markdown => report::markdown(&result),
    };
    match cli.output {
        Some(path) => std::fs::write(path, content)?,
        None => io::stdout().lock().write_all(content.as_bytes())?,
    }
    Ok(())
}

fn main() {
    if let Err(error) = run(Cli::parse()) {
        if error
            .downcast_ref::<io::Error>()
            .is_some_and(|e| e.kind() == io::ErrorKind::BrokenPipe)
        {
            return;
        }
        eprintln!("rust-dup-unifier: {error}");
        std::process::exit(1);
    }
}
