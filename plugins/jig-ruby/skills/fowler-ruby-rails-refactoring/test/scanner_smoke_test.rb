# frozen_string_literal: true

require "fileutils"
require "json"
require "minitest/autorun"
require "open3"
require "rbconfig"
require "tmpdir"

class ScannerSmokeTest < Minitest::Test
  def test_reports_representative_ruby_and_rails_candidates
    with_repository do |root|
      write(root, "app/models/order.rb", sample_source)

      stdout, stderr, status = run_scanner(
        root,
        "--format", "json",
        "--method-lines", "8",
        "--max-nesting", "2"
      )

      assert status.success?, stderr
      payload = JSON.parse(stdout)
      smells = payload.fetch("findings").map { |finding| finding.fetch("smell") }

      assert_includes smells, "Long Parameter List"
      assert_includes smells, "Flag Argument"
      assert_includes smells, "Callback Chain / hidden workflow"
      assert_includes smells, "External Effect in Lifecycle Callback"
      assert_includes smells, "Hidden Global Query Behavior"
      assert_includes smells, "Possible Query Inside Loop / N+1"
      assert_includes smells, "Validation/Callback Bypass Boundary"
    end
  end

  def test_markdown_explains_evidence_approach_and_verification
    with_repository do |root|
      write(root, "app/models/order.rb", sample_source)

      stdout, stderr, status = run_scanner(root, "--method-lines", "8")

      assert status.success?, stderr
      assert_includes stdout, "# Heuristic refactoring candidates"
      assert_includes stdout, "**Evidence:**"
      assert_includes stdout, "**Candidate Fowler moves:**"
      assert_includes stdout, "**First safe approach:**"
      assert_includes stdout, "**Verification:**"
      assert_includes stdout, "investigation prompts, not automatic verdicts"
    end
  end

  def test_excludes_test_paths_by_default_and_can_include_them
    with_repository do |root|
      write(root, "app/models/clean.rb", "class Clean\n  def ok = true\nend\n")
      write(root, "test/models/smelly_test.rb", long_test_source)

      default_stdout, default_stderr, default_status = run_scanner(
        root,
        "--format", "json",
        "--method-lines", "3"
      )
      assert default_status.success?, default_stderr
      default_files = JSON.parse(default_stdout).fetch("findings").map { |finding| finding.fetch("file") }
      refute default_files.any? { |file| file.start_with?("test/") }

      included_stdout, included_stderr, included_status = run_scanner(
        root,
        "--format", "json",
        "--method-lines", "3",
        "--include-tests"
      )
      assert included_status.success?, included_stderr
      included_files = JSON.parse(included_stdout).fetch("findings").map { |finding| finding.fetch("file") }
      assert_includes included_files, "test/models/smelly_test.rb"
    end
  end

  private

  def scanner_path
    File.expand_path("../scripts/scan_refactoring_opportunities.rb", __dir__)
  end

  def with_repository
    Dir.mktmpdir("fowler-refactoring-scan") { |root| yield root }
  end

  def write(root, relative_path, contents)
    path = File.join(root, relative_path)
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, contents)
  end

  def run_scanner(root, *arguments)
    Open3.capture3(RbConfig.ruby, scanner_path, root, *arguments)
  end

  def long_test_source
    <<~RUBY
      class SmellyTest
        def setup_everything
          first = 1
          second = 2
          third = 3
          fourth = 4
          first + second + third + fourth
        end
      end
    RUBY
  end

  def sample_source
    <<~RUBY
      class Order < ApplicationRecord
        default_scope { where(archived: false) }

        before_validation :normalize_reference
        before_save :calculate_total
        after_save :record_audit
        after_commit :notify_customer

        def finalize(customer, subtotal, currency, requested_at, force = false)
          if customer
            if subtotal.positive?
              if force
                update_columns(total_cents: subtotal)
              else
                self.total_cents = subtotal
              end
            end
          end

          currency
          requested_at
        end

        def notify_customer
          OrderMailer.confirmation(self).deliver_later
        end

        def normalize_reference
          self.reference = reference.to_s.strip
        end

        def calculate_total
          self.total_cents ||= 0
        end

        def record_audit
          Audit.create!(order_id: id)
        end
      end

      class OrderInspector
        def counts_for(users)
          users.each do |user|
            user.orders.count
            Order.find_by(customer_id: user.id)
          end
        end
      end
    RUBY
  end
end
