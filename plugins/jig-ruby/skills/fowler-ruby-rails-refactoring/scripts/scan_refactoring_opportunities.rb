#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "optparse"
require "pathname"
require "ripper"
require "time"

module FowlerRubyRailsRefactoring
  Finding = Struct.new(
    :priority,
    :confidence,
    :category,
    :smell,
    :file,
    :line,
    :symbol,
    :evidence,
    :why,
    :fowler_moves,
    :approach,
    :verification,
    keyword_init: true
  )

  Span = Struct.new(
    :type,
    :start_line,
    :end_line,
    :name,
    :container,
    keyword_init: true
  )

  class Options
    attr_accessor :format,
                  :max_findings,
                  :method_lines,
                  :very_long_method_lines,
                  :class_lines,
                  :class_methods,
                  :max_parameters,
                  :max_nesting,
                  :include_tests,
                  :include_views,
                  :include_migrations,
                  :extra_excludes

    def initialize
      @format = "markdown"
      @max_findings = 100
      @method_lines = 16
      @very_long_method_lines = 30
      @class_lines = 250
      @class_methods = 20
      @max_parameters = 4
      @max_nesting = 3
      @include_tests = false
      @include_views = false
      @include_migrations = false
      @extra_excludes = []
    end
  end

  class FileCollector
    RUBY_EXTENSIONS = %w[.rb .rake .ru].freeze
    VIEW_EXTENSIONS = %w[.erb .haml .slim].freeze
    SPECIAL_RUBY_FILES = %w[Gemfile Rakefile Guardfile Capfile].freeze
    DEFAULT_EXCLUDED_DIRECTORIES = %w[
      .git .bundle .yardoc coverage log node_modules public storage tmp vendor
    ].freeze

    def initialize(root, options)
      @root = Pathname(root).expand_path
      @options = options
    end

    def files
      return [@root] if @root.file? && eligible?(@root)

      @root.find.select { |path| path.file? && eligible?(path) }
    end

    private

    def eligible?(path)
      relative = relative_path(path)
      parts = relative.each_filename.to_a

      return false if excluded_directory?(parts)
      return false if excluded_file?(relative.to_s)
      return false if !@options.include_tests && test_path?(parts)
      return false if !@options.include_migrations && migration_path?(parts)

      extension = path.extname
      return true if RUBY_EXTENSIONS.include?(extension)
      return true if SPECIAL_RUBY_FILES.include?(path.basename.to_s)
      return true if @options.include_views && VIEW_EXTENSIONS.include?(extension)

      false
    rescue Errno::EACCES
      false
    end

    def relative_path(path)
      path.relative_path_from(@root.directory? ? @root : @root.dirname)
    rescue ArgumentError
      path
    end

    def excluded_directory?(parts)
      excluded = DEFAULT_EXCLUDED_DIRECTORIES + @options.extra_excludes
      parts.any? { |part| excluded.include?(part) }
    end

    def excluded_file?(relative)
      relative == "db/schema.rb" || relative == "db/structure.sql"
    end

    def test_path?(parts)
      parts.include?("test") || parts.include?("spec") || parts.include?("features")
    end

    def migration_path?(parts)
      parts.each_cons(2).any? { |left, right| left == "db" && right == "migrate" }
    end
  end

  class StructureParser
    OPEN_KEYWORDS = %w[def class module if unless case while until for begin do].freeze
    MODIFIER_KEYWORDS = %w[if unless while until].freeze

    attr_reader :spans

    def initialize(source)
      @source = source
      @lines = source.lines
      @spans = []
      parse
    end

    def methods
      @spans.select { |span| span.type == :def }
    end

    def containers
      @spans.select { |span| %i[class module].include?(span.type) }
    end

    def blocks
      @spans.reject { |span| %i[def class module].include?(span.type) }
    end

    private

    Frame = Struct.new(:type, :start_line, :name, :container, keyword_init: true)

    def parse
      stack = []
      line_openers = Hash.new { |hash, key| hash[key] = [] }

      previous_significant = nil

      Ripper.lex(@source).each do |token|
        position, type, text, state = token
        line_number = position[0]

        if type == :on_kw
          if previous_significant && previous_significant[1] == :on_symbeg
            previous_significant = token
            next
          end

          if text == "end"
            close_frame(stack, line_number)
            previous_significant = token
            next
          end

          if OPEN_KEYWORDS.include?(text) &&
              !modifier_keyword?(text, state) &&
              !(text == "def" && endless_method_line?(line_number)) &&
              !(text == "do" && loop_keyword_already_opened?(line_openers[line_number]))
            frame = build_frame(text, line_number, stack)
            stack << frame
            line_openers[line_number] << text
          end
        end

        previous_significant = token unless insignificant_token?(type)
      end

      final_line = [@lines.length, 1].max
      stack.reverse_each do |frame|
        @spans << Span.new(
          type: frame.type,
          start_line: frame.start_line,
          end_line: final_line,
          name: frame.name,
          container: frame.container
        )
      end
    rescue StandardError
      # The scanner is deliberately best-effort. File-level heuristics still run.
      @spans = []
    end


    def insignificant_token?(type)
      %i[on_sp on_nl on_ignored_nl on_comment].include?(type)
    end

    def close_frame(stack, line_number)
      frame = stack.pop
      return unless frame

      @spans << Span.new(
        type: frame.type,
        start_line: frame.start_line,
        end_line: line_number,
        name: frame.name,
        container: frame.container
      )
    end

    def build_frame(keyword, line_number, stack)
      case keyword
      when "def"
        Frame.new(
          type: :def,
          start_line: line_number,
          name: method_name(line_number),
          container: current_container(stack)
        )
      when "class", "module"
        parent = current_container(stack)
        raw_name = container_name(line_number, keyword)
        full_name = qualify_container(raw_name, parent)
        Frame.new(
          type: keyword.to_sym,
          start_line: line_number,
          name: full_name,
          container: parent
        )
      else
        Frame.new(
          type: keyword.to_sym,
          start_line: line_number,
          name: nil,
          container: current_container(stack)
        )
      end
    end

    def modifier_keyword?(keyword, state)
      MODIFIER_KEYWORDS.include?(keyword) &&
        (state.to_i & Ripper::EXPR_LABEL) != 0
    end

    def loop_keyword_already_opened?(openers)
      openers.any? { |keyword| %w[while until for].include?(keyword) }
    end

    def endless_method_line?(line_number)
      line = @lines.fetch(line_number - 1, "")
      line.match?(
        /^\s*def\s+(?:self\.)?(?:[A-Za-z_]\w*[!?]?|\[\]=?|[+\-*\/%<>=~|&^`]+)(?:\s*\([^)]*\))?\s*=\s*(?![=>])/
      )
    end

    def method_name(line_number)
      line = @lines.fetch(line_number - 1, "")
      body = line.sub(/^\s*def\s+/, "")
      match = body.match(
        /\A((?:self\.)?(?:[A-Za-z_]\w*[!?=]?|\[\]=?|[+\-*\/%<>=~|&^`]+))/
      )
      match ? match[1] : "<anonymous>"
    end

    def container_name(line_number, keyword)
      line = @lines.fetch(line_number - 1, "")
      body = line.sub(/^\s*#{keyword}\s+/, "").strip
      return "<singleton>" if keyword == "class" && body.start_with?("<<")

      body.split(/[\s<]/, 2).first.to_s
    end

    def qualify_container(raw_name, parent)
      return parent if raw_name == "<singleton>" && parent
      return raw_name if parent.nil? || parent.empty?
      return raw_name.sub(/^::/, "") if raw_name.start_with?("::")
      return raw_name if raw_name.include?("::")

      "#{parent}::#{raw_name}"
    end

    def current_container(stack)
      frame = stack.reverse.find { |candidate| %i[class module].include?(candidate.type) }
      frame&.name
    end
  end

  class SourceMetrics
    CONTROL_OPENERS = %w[if unless case while until for begin do].freeze
    MODIFIER_KEYWORDS = %w[if unless while until].freeze

    def initialize(source)
      @source = source
      @lines = source.lines
    end

    def significant_lines(start_line = 1, end_line = @lines.length)
      slice(start_line, end_line).count do |line|
        stripped = line.strip
        !stripped.empty? && !stripped.start_with?("#")
      end
    end

    def line(line_number)
      @lines.fetch(line_number - 1, "").rstrip
    end

    def snippet(line_number, max: 150)
      text = line(line_number).strip.gsub(/\s+/, " ")
      text.length > max ? "#{text[0, max - 1]}…" : text
    end

    def body(span)
      slice(span.start_line + 1, span.end_line - 1).join
    end

    def max_nesting(span)
      source = slice(span.start_line + 1, span.end_line - 1).join
      depth = 0
      maximum = 0
      line_openers = Hash.new { |hash, key| hash[key] = [] }

      previous_significant = nil

      Ripper.lex(source).each do |token|
        position, type, text, state = token

        if type == :on_kw && !(previous_significant && previous_significant[1] == :on_symbeg)
          if text == "end"
            depth -= 1 if depth.positive?
          elsif CONTROL_OPENERS.include?(text) &&
              !(MODIFIER_KEYWORDS.include?(text) && (state.to_i & Ripper::EXPR_LABEL) != 0) &&
              !(text == "do" && line_openers[position[0]].any? { |opener| %w[while until for].include?(opener) })
            depth += 1
            maximum = [maximum, depth].max
            line_openers[position[0]] << text
          end
        end

        previous_significant = token unless %i[on_sp on_nl on_ignored_nl on_comment].include?(type)
      end

      maximum
    rescue StandardError
      0
    end

    def parameters(span)
      signature = method_signature(span.start_line)
      return [] if signature.empty?

      parameter_text = extract_parameter_text(signature)
      split_top_level(parameter_text).map(&:strip).reject(&:empty?)
    end

    def option_keys(span, parameter_name)
      body(span).scan(/\b#{Regexp.escape(parameter_name)}\s*\[\s*[:"']([A-Za-z_]\w*)/).flatten.uniq
    end

    def slice(start_line, end_line)
      return [] if end_line < start_line

      @lines[(start_line - 1)..(end_line - 1)] || []
    end

    private

    def method_signature(start_line)
      collected = []
      balance = 0
      saw_parenthesis = false

      6.times do |offset|
        line = @lines[start_line - 1 + offset]
        break unless line

        collected << line.strip
        line.each_char do |character|
          if character == "("
            balance += 1
            saw_parenthesis = true
          elsif character == ")"
            balance -= 1 if balance.positive?
          end
        end

        break if !saw_parenthesis || balance.zero?
      end

      collected.join(" ")
    end

    def extract_parameter_text(signature)
      body = signature.sub(/^def\s+/, "")
      body = body.sub(/\A(?:self\.)?(?:[A-Za-z_]\w*[!?=]?|\[\]=?|[+\-*\/%<>=~|&^`]+)\s*/, "")
      return "" if body.empty? || body.start_with?("=")

      if body.start_with?("(")
        content = body[1..]
        depth = 1
        result = +""
        content.each_char do |character|
          depth += 1 if character == "("
          depth -= 1 if character == ")"
          break if depth.zero?

          result << character
        end
        result
      else
        body.sub(/\s*=\s*.+\z/, "")
      end
    end

    def split_top_level(text)
      return [] if text.nil? || text.strip.empty?

      pieces = []
      current = +""
      depths = Hash.new(0)
      quote = nil
      escaped = false

      text.each_char do |character|
        if quote
          current << character
          if escaped
            escaped = false
          elsif character == "\\"
            escaped = true
          elsif character == quote
            quote = nil
          end
          next
        end

        if character == "'" || character == '"'
          quote = character
          current << character
        elsif "([{".include?(character)
          depths[character] += 1
          current << character
        elsif ")]}".include?(character)
          opener = { ")" => "(", "]" => "[", "}" => "{" }.fetch(character)
          depths[opener] -= 1 if depths[opener].positive?
          current << character
        elsif character == "," && depths.values.all?(&:zero?)
          pieces << current
          current = +""
        else
          current << character
        end
      end

      pieces << current unless current.empty?
      pieces
    end
  end

  class Analyzer
    CALLBACK_PATTERN = /^\s*((?:before|after|around)_(?:validation|save|create|update|destroy|commit|rollback|touch|find|initialize|create_commit|update_commit|destroy_commit|save_commit))\b(.*)$/
    EXTERNAL_EFFECT_PATTERN = /\b(?:deliver_(?:now|later)|perform_(?:now|later)|Net::HTTP|Faraday|HTTParty|HTTP\.|File\.|FileUtils\.|Aws::|broadcast|publish|webhook|notify)\b/
    CONSTANT_QUERY_PATTERN = /\b[A-Z][A-Za-z0-9_:]*\.(?:find(?:_by)?!?|where|exists\?|count|sum|average|minimum|maximum|pluck|pick|load|to_a|first!?|last!?|take!?)(?:\b|\()/
    ASSOCIATION_QUERY_METHODS = "find|find_by|find_by!|where|exists\?|count|sum|average|minimum|maximum|pluck|pick|load|to_a|first|first!|last|last!|take|take!"
    BULK_BYPASS_PATTERN = /\b(?:update_all|delete_all|insert_all|upsert_all|update_columns?|save\s*\(\s*validate:\s*false|skip_callback)\b/
    DYNAMIC_DISPATCH_PATTERN = /\b(?:method_missing|respond_to_missing\?|define_method|class_eval|module_eval|constantize|safe_constantize|public_send|send)\b/
    ASSOCIATION_PATTERN = /^\s*(?:has_many|has_one|belongs_to|has_and_belongs_to_many)\b/
    VALIDATION_PATTERN = /^\s*(?:validates|validate)\b/
    SCOPE_PATTERN = /^\s*(?:scope|default_scope)\b/

    def initialize(root, options)
      @root = Pathname(root).expand_path
      @options = options
      @findings = []
    end

    def analyze
      collector = FileCollector.new(@root, @options)
      collector.files.each { |path| analyze_file(path) }
      sort_findings(@findings).first(@options.max_findings)
    end

    private

    def analyze_file(path)
      source = path.read(encoding: "UTF-8")
      parser = StructureParser.new(source)
      metrics = SourceMetrics.new(source)
      relative = relative_path(path)

      analyze_file_size(relative, metrics)
      analyze_methods(relative, source, parser, metrics)
      analyze_containers(relative, source, parser, metrics)
      analyze_callbacks(relative, source, parser, metrics)
      analyze_default_scope(relative, source, metrics)
      analyze_bulk_bypasses(relative, source, metrics)
      analyze_query_loops(relative, source, parser, metrics)
      analyze_all_each(relative, source, metrics)
      analyze_concerns(relative, source, parser, metrics)
      analyze_dynamic_dispatch(relative, source, metrics)
      analyze_global_state(relative, source, metrics)
    rescue Encoding::InvalidByteSequenceError, Encoding::UndefinedConversionError
      # Skip non-UTF-8 source rather than producing misleading line evidence.
    rescue Errno::EACCES, Errno::ENOENT
      # A concurrent checkout change or unreadable file should not abort the scan.
    end

    def analyze_file_size(relative, metrics)
      lines = metrics.significant_lines
      return unless lines > (@options.class_lines * 2)

      add_finding(
        priority: lines > (@options.class_lines * 3) ? "P1" : "P2",
        confidence: "low",
        category: "structure",
        smell: "Large File / possible Divergent Change",
        file: relative,
        line: 1,
        evidence: "#{lines} significant lines in one Ruby file",
        why: "File size can hide multiple responsibilities, but declarations, DSLs, and data tables can inflate this metric.",
        fowler_moves: ["Extract Class", "Move Function", "Split Phase"],
        approach: "Inspect class/module boundaries and change history; extract only a cohesive responsibility with an independently testable seam.",
        verification: "Run tests for each moved responsibility and the loader check after every constant move."
      )
    end

    def analyze_methods(relative, source, parser, metrics)
      parser.methods.each do |method_span|
        body_lines = metrics.significant_lines(method_span.start_line + 1, method_span.end_line - 1)
        nesting = metrics.max_nesting(method_span)
        parameters = metrics.parameters(method_span)
        symbol = qualified_method(method_span)

        if body_lines > @options.method_lines
          very_long = body_lines > @options.very_long_method_lines
          add_finding(
            priority: very_long ? "P1" : "P2",
            confidence: very_long ? "high" : "medium",
            category: "structure",
            smell: "Long Function",
            file: relative,
            line: method_span.start_line,
            symbol: symbol,
            evidence: "#{body_lines} significant body lines; max nesting #{nesting}",
            why: "The method may mix phases or abstraction levels and increase the amount of state a reader must track.",
            fowler_moves: ["Extract Function", "Replace Temp with Query", "Split Phase", "Decompose Conditional"],
            approach: "First name one coherent decision or phase with a private extraction; keep parameters and side effects unchanged, then reassess before introducing a class.",
            verification: "Run the narrowest tests for #{symbol} after each extraction; compare return values, exceptions, mutation, and side-effect order."
          )
        end

        if nesting > @options.max_nesting
          add_finding(
            priority: nesting > (@options.max_nesting + 1) ? "P1" : "P2",
            confidence: "medium",
            category: "conditionals",
            smell: "Deeply Nested Conditional",
            file: relative,
            line: method_span.start_line,
            symbol: symbol,
            evidence: "maximum control-flow nesting depth #{nesting}",
            why: "Nested exceptional cases can obscure the main path and duplicate policy conditions.",
            fowler_moves: ["Replace Nested Conditional with Guard Clauses", "Decompose Conditional", "Extract Function"],
            approach: "Characterize branch behavior, extract named predicates, then introduce guard clauses one branch at a time without reordering side-effectful conditions.",
            verification: "Exercise every branch and preserve exception/render/redirect flow."
          )
        end

        if parameters.length > @options.max_parameters
          add_finding(
            priority: parameters.length > (@options.max_parameters + 2) ? "P2" : "P3",
            confidence: "medium",
            category: "data",
            smell: "Long Parameter List",
            file: relative,
            line: method_span.start_line,
            symbol: symbol,
            evidence: "#{parameters.length} parameters: #{parameters.join(', ')}",
            why: "Several independent arguments can make call sites fragile; repeated groups may represent a missing concept.",
            fowler_moves: ["Introduce Parameter Object", "Preserve Whole Object", "Change Function Declaration"],
            approach: "Prefer a compatibility wrapper and keyword arguments first; introduce a value/input object only if the values travel together or own invariants.",
            verification: "Search dynamic and static callers; preserve defaults, positional compatibility, and serialization."
          )
        end

        flag_parameters = parameters.select { |parameter| flag_parameter?(parameter) }
        unless flag_parameters.empty?
          add_finding(
            priority: "P2",
            confidence: "medium",
            category: "conditionals",
            smell: "Flag Argument",
            file: relative,
            line: method_span.start_line,
            symbol: symbol,
            evidence: "mode-like parameter(s): #{flag_parameters.join(', ')}",
            why: "A boolean or mode flag often hides multiple operations behind one name.",
            fowler_moves: ["Remove Flag Argument", "Change Function Declaration", "Replace Conditional with Polymorphism"],
            approach: "Identify distinct caller intentions; add named entry points that delegate to the current implementation, migrate callers, then remove the flag if the protocol becomes clearer.",
            verification: "Cover each mode and default path; preserve public compatibility until all callers are migrated."
          )
        end

        option_parameter_names(parameters).each do |parameter_name|
          keys = metrics.option_keys(method_span, parameter_name)
          next unless keys.length >= 4

          add_finding(
            priority: "P2",
            confidence: "medium",
            category: "data",
            smell: "Implicit Record / Data Clump",
            file: relative,
            line: method_span.start_line,
            symbol: symbol,
            evidence: "#{parameter_name} accesses #{keys.length} keys: #{keys.join(', ')}",
            why: "A repeated option-hash schema can spread defaults, validation, and string/symbol key assumptions.",
            fowler_moves: ["Encapsulate Record", "Introduce Parameter Object", "Split Phase"],
            approach: "Add a wrapper that preserves current key/default semantics, route reads through it, then move normalization or validation separately.",
            verification: "Test missing keys, false/nil values, string versus symbol keys, and serialization shape."
          )
        end
      end
    end

    def analyze_containers(relative, source, parser, metrics)
      parser.containers.each do |container|
        body_lines = metrics.significant_lines(container.start_line + 1, container.end_line - 1)
        method_count = parser.methods.count do |method_span|
          method_span.container == container.name &&
            method_span.start_line >= container.start_line &&
            method_span.end_line <= container.end_line
        end
        next if container.type == :module && method_count.zero?
        next unless body_lines > @options.class_lines || method_count > @options.class_methods

        add_finding(
          priority: body_lines > (@options.class_lines * 1.6) || method_count > (@options.class_methods + 10) ? "P1" : "P2",
          confidence: "medium",
          category: "responsibility",
          smell: "Large Class / possible Divergent Change",
          file: relative,
          line: container.start_line,
          symbol: container.name,
          evidence: "#{body_lines} significant body lines and #{method_count} directly owned methods",
          why: "The container may own unrelated change reasons, though Rails declarations and cohesive aggregate behavior can legitimately be large.",
          fowler_moves: ["Extract Class", "Move Function", "Combine Functions into Class", "Split Phase"],
          approach: "Cluster methods by data used and reasons for change; extract the highest-cohesion cluster through delegation before moving state or public APIs.",
          verification: "Run tests for both owner and collaborator; preserve visibility, callback registration, autoloading, and transaction boundaries."
        )
      end
    end

    def analyze_callbacks(relative, source, parser, metrics)
      callbacks = []
      source.each_line.with_index(1) do |line, line_number|
        match = line.match(CALLBACK_PATTERN)
        next unless match

        callbacks << {
          name: match[1],
          arguments: match[2],
          line: line_number,
          snippet: metrics.snippet(line_number)
        }
      end

      if callbacks.length >= 4
        add_finding(
          priority: callbacks.length >= 7 ? "P1" : "P2",
          confidence: "medium",
          category: "side-effects",
          smell: "Callback Chain / hidden workflow",
          file: relative,
          line: callbacks.first[:line],
          evidence: "#{callbacks.length} lifecycle callbacks in one file: #{callbacks.map { |callback| callback[:name] }.uniq.join(', ')}",
          why: "Several callbacks can create ordering dependencies and make persistence entry points difficult to reason about.",
          fowler_moves: ["Extract Function", "Separate Query from Modifier", "Split Phase", "Move Function"],
          approach: "Characterize save/rollback/commit behavior; extract callback bodies without changing registration, then expose orchestration only where workflow rather than a local invariant is present.",
          verification: "Test every persistence path, callback ordering that matters, rollback behavior, and duplicate invocation."
        )
      end

      method_index = parser.methods.each_with_object({}) { |span, hash| hash[span.name.to_s.sub(/^self\./, "")] = span }
      callbacks.each do |callback|
        callback_targets(callback[:arguments]).each do |target|
          method_span = method_index[target]
          next unless method_span
          next unless metrics.body(method_span).match?(EXTERNAL_EFFECT_PATTERN)

          add_finding(
            priority: "P1",
            confidence: "high",
            category: "side-effects",
            smell: "External Effect in Lifecycle Callback",
            file: relative,
            line: callback[:line],
            symbol: qualified_method(method_span),
            evidence: "#{callback[:name]} invokes #{target}, whose body appears to mail, enqueue, publish, call a remote system, or touch files",
            why: "The external effect's timing and failure behavior are coupled to persistence and may be hidden from callers.",
            fowler_moves: ["Extract Function", "Separate Query from Modifier", "Move Function", "Split Phase"],
            approach: "First preserve the callback and isolate the external boundary; characterize transaction/commit behavior before introducing explicit orchestration or a commit-aware job/event.",
            verification: "Test commit, rollback, exception, retry, and duplicate-delivery behavior. Do not silently change `after_save` to `after_commit`."
          )
        end
      end
    end

    def analyze_default_scope(relative, source, metrics)
      source.each_line.with_index(1) do |line, line_number|
        next unless line.match?(/^\s*default_scope\b/)

        add_finding(
          priority: "P2",
          confidence: "medium",
          category: "queries",
          smell: "Hidden Global Query Behavior",
          file: relative,
          line: line_number,
          evidence: metrics.snippet(line_number),
          why: "`default_scope` changes every relation and may affect scope merging and record construction.",
          fowler_moves: ["Encapsulate Variable", "Extract Function", "Change Function Declaration"],
          approach: "Identify invariant/security dependencies; introduce an explicit named scope, migrate callers in small slices, and remove the default only after verifying unscoped paths.",
          verification: "Test reads, associations, joins, creation defaults, admin/unscoped paths, and authorization/tenant boundaries."
        )
      end
    end

    def analyze_bulk_bypasses(relative, source, metrics)
      source.each_line.with_index(1) do |line, line_number|
        next if pattern_definition_line?(line)
        next unless line.match?(BULK_BYPASS_PATTERN)

        add_finding(
          priority: "P1",
          confidence: "high",
          category: "behavior-boundary",
          smell: "Validation/Callback Bypass Boundary",
          file: relative,
          line: line_number,
          evidence: metrics.snippet(line_number),
          why: "The operation may intentionally bypass callbacks, validations, dirty tracking, or object instantiation; surrounding refactors can accidentally change those semantics.",
          fowler_moves: ["Extract Function", "Change Function Declaration", "Encapsulate Variable"],
          approach: "Encapsulate the operation behind a name that states the bypass intent and document/test the invariants handled elsewhere; do not replace it with per-record writes under a refactoring label.",
          verification: "Test affected rows, callbacks that must not run, timestamps/dirty tracking, locks, and performance separately."
        )
      end
    end

    def analyze_query_loops(relative, source, parser, metrics)
      parser.blocks.each do |block|
        next unless block.type == :do

        opener = metrics.line(block.start_line)
        next unless opener.match?(/\.(?:each|map|filter_map|select|reject|each_with_object|find_each|find_in_batches)\b.*\bdo\b/)

        variables = block_variables(opener)
        body = metrics.slice(block.start_line + 1, block.end_line - 1)
        query_line_index = body.index { |line| likely_query_in_loop?(line, variables) }
        next unless query_line_index

        query_line = block.start_line + 1 + query_line_index
        add_finding(
          priority: "P1",
          confidence: "medium",
          category: "queries",
          smell: "Possible Query Inside Loop / N+1",
          file: relative,
          line: query_line,
          evidence: "loop at line #{block.start_line}; candidate query: #{metrics.snippet(query_line)}",
          why: "A database terminal operation inside an enumerable loop can multiply queries and hide data access in iteration.",
          fowler_moves: ["Extract Function", "Move Function", "Replace Loop with Pipeline", "Split Phase"],
          approach: "Confirm with SQL logs/query counts or strict loading; then extract the data requirement and batch, preload, or aggregate while preserving relation cardinality and ordering.",
          verification: "Assert returned records and order, query count, memory behavior, and behavior for missing associations."
        )
      end
    end

    def analyze_all_each(relative, source, metrics)
      source.each_line.with_index(1) do |line, line_number|
        next unless line.match?(/\b[A-Z][A-Za-z0-9_:]*\.all\.(?:each|map)\b/)

        add_finding(
          priority: "P2",
          confidence: "medium",
          category: "queries",
          smell: "Whole-Table Materialization",
          file: relative,
          line: line_number,
          evidence: metrics.snippet(line_number),
          why: "Loading an entire relation before iteration may create memory pressure as data grows.",
          fowler_moves: ["Substitute Algorithm", "Replace Loop with Pipeline"],
          approach: "Determine required ordering and concurrency semantics; use batch iteration only when behavior permits, and classify the measured performance change separately from structural cleanup.",
          verification: "Test ordering, skipped/duplicated records under concurrent updates, batch boundaries, and query/memory measurements."
        )
      end
    end

    def analyze_concerns(relative, source, parser, metrics)
      return unless relative.split(File::SEPARATOR).include?("concerns")

      macro_count = source.lines.count do |line|
        line.match?(CALLBACK_PATTERN) ||
          line.match?(ASSOCIATION_PATTERN) ||
          line.match?(VALIDATION_PATTERN) ||
          line.match?(SCOPE_PATTERN)
      end
      method_count = parser.methods.length
      return unless macro_count >= 5 && method_count >= 3

      add_finding(
        priority: "P2",
        confidence: "medium",
        category: "coupling",
        smell: "Concern with Broad Host Coupling",
        file: relative,
        line: 1,
        evidence: "#{macro_count} Rails macros and #{method_count} methods in a concern",
        why: "A concern that adds associations, validations, callbacks, scopes, and methods can hide host requirements and inclusion-order behavior.",
        fowler_moves: ["Extract Class", "Move Function", "Inline Class"],
        approach: "List required host columns/methods and consumers; keep a concern only for a coherent shared role, otherwise extract an explicit collaborator or inline single-use behavior.",
        verification: "Test every including class, inclusion order, callback registration, and autoloading."
      )
    end

    def analyze_dynamic_dispatch(relative, source, metrics)
      matches = []
      source.each_line.with_index(1) do |line, line_number|
        next if pattern_definition_line?(line)
        matches << [line_number, metrics.snippet(line_number)] if line.match?(DYNAMIC_DISPATCH_PATTERN)
      end
      return if matches.empty?

      first_line, first_snippet = matches.first
      add_finding(
        priority: "P2",
        confidence: "low",
        category: "refactoring-risk",
        smell: "Dynamic Dispatch / Hidden Caller Risk",
        file: relative,
        line: first_line,
        evidence: "#{matches.length} dynamic-dispatch/metaprogramming occurrence(s); first: #{first_snippet}",
        why: "Text search may miss callers and generated methods, making rename, move, and dead-code refactorings less safe.",
        fowler_moves: ["Encapsulate Variable", "Change Function Declaration", "Replace Function with Command"],
        approach: "Map the generated protocol and add characterization tests before renaming or deleting; isolate dynamic behavior behind an explicit API where practical.",
        verification: "Exercise runtime registration, `respond_to?`, serialization/callback hooks, and all configured implementations."
      )
    end

    def analyze_global_state(relative, source, metrics)
      source.each_line.with_index(1) do |line, line_number|
        next unless line.match?(/@@[A-Za-z_]\w*|\$[A-Za-z_]\w*/)
        next if line.strip.start_with?("#")
        next if line.match?(/\$(?:PROGRAM_NAME|LOAD_PATH|stdout|stderr|stdin|VERBOSE|DEBUG)\b/)

        add_finding(
          priority: "P2",
          confidence: "medium",
          category: "state",
          smell: "Global or Class-Variable State",
          file: relative,
          line: line_number,
          evidence: metrics.snippet(line_number),
          why: "Broad mutable state can couple callers and create thread, process, test-isolation, or Rails reload hazards.",
          fowler_moves: ["Encapsulate Variable", "Change Reference to Value", "Move Field"],
          approach: "Identify the intended lifetime and ownership; add an accessor or dependency boundary before relocating or making the value immutable.",
          verification: "Test parallel access, reset behavior, process boundaries, and development reloads."
        )
      end
    end

    def block_variables(opener)
      match = opener.match(/\|([^|]+)\|/)
      return [] unless match

      match[1].split(",").map { |name| name.strip.sub(/^\*/, "") }.select { |name| name.match?(/\A[a-z_]\w*\z/) }
    end

    def likely_query_in_loop?(line, variables)
      code = line.sub(/#.*\z/, "")
      return true if code.match?(CONSTANT_QUERY_PATTERN)

      variables.any? do |variable|
        code.match?(/\b#{Regexp.escape(variable)}\.[a-z_]\w*(?:\.[a-z_]\w*)*\.(?:#{ASSOCIATION_QUERY_METHODS})(?:\b|\()/)
      end
    end

    def pattern_definition_line?(line)
      line.strip.match?(/\A[A-Z][A-Z0-9_]*_PATTERN\s*=/)
    end

    def flag_parameter?(parameter)
      normalized = parameter.gsub(/\s+/, "")
      return true if normalized.match?(/=(?:true|false)\z/)

      name = normalized.sub(/^\*{0,2}/, "").split(/[=:]/, 2).first.to_s
      name.match?(/\A(?:force|skip|include|exclude|with|without|validate|notify|async|dry_run|reload|strict)(?:_|\z)/)
    end

    def option_parameter_names(parameters)
      parameters.each_with_object([]) do |parameter, names|
        match = parameter.match(/\A\s*(?:\*\*)?(options|opts|params|attributes|kwargs)\b/)
        names << match[1] if match
      end
    end

    def callback_targets(arguments)
      arguments.scan(/:([A-Za-z_]\w*[!?=]?)/).flatten +
        arguments.scan(/["']([A-Za-z_]\w*[!?=]?)["']/).flatten
    end

    def qualified_method(span)
      return span.name unless span.container

      separator = span.name.to_s.start_with?("self.") ? "." : "#"
      method_name = span.name.to_s.sub(/^self\./, "")
      "#{span.container}#{separator}#{method_name}"
    end

    def relative_path(path)
      base = @root.directory? ? @root : @root.dirname
      path.relative_path_from(base).to_s
    rescue ArgumentError
      path.to_s
    end

    def add_finding(attributes)
      @findings << Finding.new(**attributes)
    end

    def sort_findings(findings)
      priority_rank = { "P1" => 0, "P2" => 1, "P3" => 2 }
      confidence_rank = { "high" => 0, "medium" => 1, "low" => 2 }
      findings.sort_by do |finding|
        [
          priority_rank.fetch(finding.priority, 9),
          confidence_rank.fetch(finding.confidence, 9),
          finding.file.to_s,
          finding.line.to_i,
          finding.smell.to_s
        ]
      end
    end
  end

  class Reporter
    def initialize(root, findings, format)
      @root = Pathname(root).expand_path
      @findings = findings
      @format = format
    end

    def render
      @format == "json" ? render_json : render_markdown
    end

    private

    def render_json
      payload = {
        scanner: "fowler-ruby-rails-refactoring",
        root: @root.to_s,
        generated_at: Time.now.utc.iso8601,
        caveat: "Heuristic candidates are investigation prompts, not automatic refactoring verdicts.",
        findings: @findings.map { |finding| finding.to_h }
      }
      JSON.pretty_generate(payload)
    end

    def render_markdown
      output = []
      output << "# Heuristic refactoring candidates"
      output << ""
      output << "Root: `#{@root}`"
      output << ""
      output << "> These are investigation prompts, not automatic verdicts. Confirm tests, callers, runtime behavior, change pressure, and framework/version constraints before proposing a refactoring."
      output << ""

      if @findings.empty?
        output << "No candidates crossed the configured thresholds. This does not prove the absence of design problems."
        return output.join("\n")
      end

      output << "| Priority | Confidence | Location | Candidate | Fowler moves |"
      output << "|---|---|---|---|---|"
      @findings.each do |finding|
        location = "#{finding.file}:#{finding.line}"
        location += " (`#{finding.symbol}`)" if finding.symbol
        output << "| #{finding.priority} | #{finding.confidence} | #{escape_table(location)} | #{escape_table(finding.smell)} | #{escape_table(Array(finding.fowler_moves).join(', '))} |"
      end
      output << ""

      @findings.each_with_index do |finding, index|
        output << "## #{index + 1}. #{finding.priority} — #{finding.smell}"
        output << ""
        output << "**Location:** `#{finding.file}:#{finding.line}`#{finding.symbol ? " — `#{finding.symbol}`" : ""}  "
        output << "**Confidence:** #{finding.confidence}  "
        output << "**Category:** #{finding.category}"
        output << ""
        output << "**Evidence:** #{finding.evidence}"
        output << ""
        output << "**Why it may matter:** #{finding.why}"
        output << ""
        output << "**Candidate Fowler moves:** #{Array(finding.fowler_moves).join(', ')}"
        output << ""
        output << "**First safe approach:** #{finding.approach}"
        output << ""
        output << "**Verification:** #{finding.verification}"
        output << ""
      end

      output.join("\n")
    end

    def escape_table(value)
      value.to_s.gsub("|", "\\|").gsub("\n", " ")
    end
  end

  module CLI
    module_function

    def run(argv)
      options = Options.new
      parser = option_parser(options)
      parser.parse!(argv)
      root = argv.shift || "."

      unless %w[markdown json].include?(options.format)
        warn "Unsupported format: #{options.format.inspect}. Use markdown or json."
        return 2
      end

      findings = Analyzer.new(root, options).analyze
      puts Reporter.new(root, findings, options.format).render
      0
    rescue OptionParser::ParseError => error
      warn error.message
      warn parser
      2
    rescue Errno::ENOENT => error
      warn error.message
      2
    end

    def option_parser(options)
      OptionParser.new do |opts|
        opts.banner = "Usage: scan_refactoring_opportunities.rb [PATH] [options]"

        opts.on("--format FORMAT", %w[markdown json], "Output format: markdown or json") { |value| options.format = value }
        opts.on("--max-findings N", Integer, "Maximum findings (default: #{options.max_findings})") { |value| options.max_findings = value }
        opts.on("--method-lines N", Integer, "Long-method threshold (default: #{options.method_lines})") { |value| options.method_lines = value }
        opts.on("--very-long-method-lines N", Integer, "P1 long-method threshold (default: #{options.very_long_method_lines})") { |value| options.very_long_method_lines = value }
        opts.on("--class-lines N", Integer, "Large-class threshold (default: #{options.class_lines})") { |value| options.class_lines = value }
        opts.on("--class-methods N", Integer, "Large-class method threshold (default: #{options.class_methods})") { |value| options.class_methods = value }
        opts.on("--max-parameters N", Integer, "Parameter-count threshold (default: #{options.max_parameters})") { |value| options.max_parameters = value }
        opts.on("--max-nesting N", Integer, "Nesting-depth threshold (default: #{options.max_nesting})") { |value| options.max_nesting = value }
        opts.on("--include-tests", "Include test/spec/features paths") { options.include_tests = true }
        opts.on("--include-views", "Include ERB/Haml/Slim files for file-level heuristics") { options.include_views = true }
        opts.on("--include-migrations", "Include db/migrate") { options.include_migrations = true }
        opts.on("--exclude DIR", "Exclude an additional directory name (repeatable)") { |value| options.extra_excludes << value }
        opts.on("-h", "--help", "Show this help") do
          puts opts
          exit 0
        end
      end
    end
  end
end

if $PROGRAM_NAME == __FILE__
  exit FowlerRubyRailsRefactoring::CLI.run(ARGV)
end
