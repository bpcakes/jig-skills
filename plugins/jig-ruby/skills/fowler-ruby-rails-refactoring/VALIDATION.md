# Validation

Validated on 2026-08-06 with Ruby 3.3.8 using only the Ruby standard library.

Commands:

```bash
ruby -w -c scripts/scan_refactoring_opportunities.rb
ruby -w -c test/scanner_smoke_test.rb
ruby -w test/scanner_smoke_test.rb
ruby scripts/scan_refactoring_opportunities.rb . --format markdown --max-findings 8
ruby scripts/scan_refactoring_opportunities.rb . --format json --max-findings 8
```

Result:

```text
3 runs, 33 assertions, 0 failures, 0 errors, 0 skips
```

The JSON output was parsed successfully and contained the expected top-level fields and finding records. The Markdown output contained evidence, candidate Fowler moves, a first safe approach, and verification guidance.
