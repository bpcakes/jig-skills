#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".cache",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "vendor",
  "generated",
  "__generated__",
  "storybook-static",
]);

const FORM_MODULES = ["react-hook-form", "formik", "final-form"];
const QUERY_MODULES = [
  "@tanstack/react-query",
  "react-query",
  "swr",
  "@apollo/client",
  "urql",
];
const ROUTER_STORE_MODULES = [
  "react-router",
  "react-router-dom",
  "next/router",
  "next/navigation",
  "react-redux",
  "@reduxjs/toolkit",
  "zustand",
  "xstate",
  "@xstate/react",
];
const TRANSPORT_MODULES = ["axios", "ky", "superagent", "@trpc/client"];

function parseArgs(argv) {
  const options = {
    target: ".",
    format: "text",
    includeTests: false,
    maxFiles: 10000,
  };

  let targetSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--include-tests") {
      options.includeTests = true;
    } else if (arg === "--format") {
      const value = argv[index + 1];
      if (!value || !["text", "json", "jsonl"].includes(value)) {
        throw new Error("--format must be one of: text, json, jsonl");
      }
      options.format = value;
      index += 1;
    } else if (arg === "--max-files") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max-files must be a positive integer");
      }
      options.maxFiles = value;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!targetSeen) {
      options.target = arg;
      targetSeen = true;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  process.stdout.write(`TypeScript/React Abstraction Police candidate scanner\n\n`);
  process.stdout.write(`Usage: node scripts/scan.mjs [path] [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --format text|json|jsonl   Output format (default: text)\n`);
  process.stdout.write(`  --include-tests            Include test/spec files and test-only checks\n`);
  process.stdout.write(`  --max-files N              Stop after N source files (default: 10000)\n`);
  process.stdout.write(`  -h, --help                 Show this help\n\n`);
  process.stdout.write(`Candidates are investigation leads, not confirmed findings.\n`);
}

function isTestFile(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    normalized.includes("/__tests__/")
  );
}

function isSourceFile(filePath, includeTests) {
  const base = path.basename(filePath);
  if (base.endsWith(".d.ts") || base.includes(".min.")) return false;
  if (base.endsWith(".snap") || base.endsWith(".map")) return false;
  if (!SOURCE_EXTENSIONS.has(path.extname(base))) return false;
  if (!includeTests && isTestFile(filePath)) return false;
  return true;
}

async function collectFiles(target, options) {
  const absoluteTarget = path.resolve(target);
  const stat = await fs.stat(absoluteTarget);

  if (stat.isFile()) {
    return isSourceFile(absoluteTarget, options.includeTests)
      ? [absoluteTarget]
      : [];
  }

  if (!stat.isDirectory()) {
    throw new Error(`Target is neither a file nor a directory: ${target}`);
  }

  const files = [];
  const stack = [absoluteTarget];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => b.name.localeCompare(a.name));

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isSourceFile(fullPath, options.includeTests)) continue;
      files.push(fullPath);
      if (files.length > options.maxFiles) {
        throw new Error(
          `Source file limit exceeded (${options.maxFiles}). Narrow the scope or raise --max-files.`,
        );
      }
    }
  }

  return files.sort();
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function evidenceAt(text, offset) {
  const start = text.lastIndexOf("\n", offset) + 1;
  const nextNewline = text.indexOf("\n", offset);
  const end = nextNewline === -1 ? text.length : nextNewline;
  const line = text.slice(start, end).trim().replace(/\s+/g, " ");
  return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

function findMatchingBrace(text, openingOffset) {
  let depth = 0;
  let state = "code";

  for (let index = openingOffset; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (char === "\\") index += 1;
      else if (char === "'") state = "code";
      continue;
    }
    if (state === "double-quote") {
      if (char === "\\") index += 1;
      else if (char === '"') state = "code";
      continue;
    }
    if (state === "template") {
      if (char === "\\") index += 1;
      else if (char === "`") state = "code";
      continue;
    }

    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'") {
      state = "single-quote";
      continue;
    }
    if (char === '"') {
      state = "double-quote";
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function extractExportedObjectTypes(text) {
  const blocks = [];
  const patterns = [
    /export\s+interface\s+([A-Za-z_$][\w$]*)[^\{]*\{/g,
    /export\s+type\s+([A-Za-z_$][\w$]*)[^=;]*=\s*\{/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const openingOffset = match.index + match[0].lastIndexOf("{");
      const closingOffset = findMatchingBrace(text, openingOffset);
      if (closingOffset === -1) continue;
      blocks.push({
        name: match[1],
        start: match.index,
        openingOffset,
        closingOffset,
        body: text.slice(openingOffset + 1, closingOffset),
        fullText: text.slice(match.index, closingOffset + 1),
      });
    }
  }

  return blocks;
}

function parseImports(text) {
  const imports = [];
  const pattern = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/g;

  for (const match of text.matchAll(pattern)) {
    const clause = match[1].trim();
    const moduleName = match[2];
    const identifiers = new Set();

    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) identifiers.add(namespace[1]);

    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const part of named[1].split(",")) {
        const cleaned = part.trim().replace(/^type\s+/, "");
        if (!cleaned) continue;
        const aliasParts = cleaned.split(/\s+as\s+/);
        identifiers.add((aliasParts[1] || aliasParts[0]).trim());
      }
    }

    const withoutNamed = clause.replace(/\{[\s\S]*?\}/, "").trim();
    const defaultName = withoutNamed.split(",")[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(defaultName)) identifiers.add(defaultName);

    imports.push({ moduleName, identifiers: [...identifiers], offset: match.index });
  }

  return imports;
}

function moduleMatches(moduleName, prefixes) {
  return prefixes.some(
    (prefix) => moduleName === prefix || moduleName.startsWith(`${prefix}/`),
  );
}

function containsIdentifier(text, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

function propertyNames(body, valuePattern) {
  const names = [];
  const pattern = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([^;\n]+)/gm;
  for (const match of body.matchAll(pattern)) {
    if (valuePattern.test(match[2])) names.push(match[1]);
    valuePattern.lastIndex = 0;
  }
  return names;
}

function addCandidate(candidates, file, text, offset, candidate) {
  const item = {
    ruleId: candidate.ruleId,
    confidenceHint: candidate.confidenceHint || "medium",
    file,
    line: lineNumberAt(text, offset),
    message: candidate.message,
    evidence: candidate.evidence || evidenceAt(text, offset),
  };

  const key = `${item.ruleId}|${item.file}|${item.line}|${item.message}`;
  if (!candidates.some((existing) => existing._key === key)) {
    Object.defineProperty(item, "_key", { value: key, enumerable: false });
    candidates.push(item);
  }
}

function analyzeFile(text, relativeFile, options) {
  const candidates = [];
  const blocks = extractExportedObjectTypes(text);
  const imports = parseImports(text);

  for (const match of text.matchAll(
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*Context)\s*=\s*(?:React\.)?createContext\b/g,
  )) {
    addCandidate(candidates, relativeFile, text, match.index, {
      ruleId: "AP-TSR-205",
      message: `Exported Context object ${match[1]} exposes Context identity and provider value shape.`,
    });
  }

  const localContexts = [];
  for (const match of text.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*Context)\s*=\s*(?:React\.)?createContext\b/g,
  )) {
    localContexts.push({ name: match[1], offset: match.index });
  }
  for (const context of localContexts) {
    const exportPattern = new RegExp(
      `export\\s*\\{[^}]*\\b${context.name}\\b[^}]*\\}`,
    );
    if (exportPattern.test(text)) {
      addCandidate(candidates, relativeFile, text, context.offset, {
        ruleId: "AP-TSR-205",
        message: `Context object ${context.name} is exported separately from its declaration.`,
      });
    }
  }

  for (const block of blocks) {
    const booleanProps = propertyNames(block.body, /^boolean\b/);
    if (booleanProps.length >= 4) {
      addCandidate(candidates, relativeFile, text, block.start, {
        ruleId: "AP-TSR-203",
        message: `${block.name} exposes ${booleanProps.length} boolean properties; verify that callers are not encoding internal branches or invalid combinations.`,
        evidence: booleanProps.slice(0, 8).join(", "),
      });
    }

    const rawSetterMatches = [
      ...block.body.matchAll(
        /^\s*(?:readonly\s+)?(set[A-Z][A-Za-z0-9_$]*)\??\s*:\s*([^;\n]+)/gm,
      ),
    ];
    const hasReactSetter = /Dispatch\s*<\s*SetStateAction\s*</.test(block.body);
    if (hasReactSetter || rawSetterMatches.length >= 2) {
      addCandidate(candidates, relativeFile, text, block.start, {
        ruleId: "AP-TSR-201",
        message: `${block.name} exposes raw state setters or React state-setter types.`,
        evidence:
          rawSetterMatches.map((match) => match[1]).join(", ") ||
          "Dispatch<SetStateAction<...>>",
      });
    }

    const classNames = [
      ...block.body.matchAll(
        /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*ClassName)\??\s*:/gm,
      ),
    ].map((match) => match[1]);
    const refs = [
      ...block.body.matchAll(
        /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*Ref)\??\s*:/gm,
      ),
    ].map((match) => match[1]);
    if (classNames.length + refs.length >= 3) {
      addCandidate(candidates, relativeFile, text, block.start, {
        ruleId: "AP-TSR-206",
        message: `${block.name} exposes multiple DOM/styling internals; verify whether the part structure is an intentional stable contract.`,
        evidence: [...classNames, ...refs].slice(0, 8).join(", "),
      });
    }

    const escapeHatches = [
      ...block.body.matchAll(
        /^\s*(?:readonly\s+)?((?:unsafe|unstable|internal|raw|bypass|force|skip|suppress|disableValidation)[A-Za-z0-9_$]*)\??\s*:/gim,
      ),
    ].map((match) => match[1]);
    if (
      escapeHatches.length >= 2 ||
      escapeHatches.some((name) => /^(unsafe|internal)/i.test(name))
    ) {
      addCandidate(candidates, relativeFile, text, block.start, {
        ruleId: "AP-TSR-104",
        message: `${block.name} exposes escape-hatch options that may compensate for hidden policy.`,
        evidence: escapeHatches.slice(0, 8).join(", "),
      });
    }

    const queryConfig = [
      ...block.body.matchAll(
        /^\s*(?:readonly\s+)?(queryKey|staleTime|gcTime|cacheTime|refetchOn[A-Za-z0-9_$]*|invalidate[A-Za-z0-9_$]*)\??\s*:/gm,
      ),
    ].map((match) => match[1]);
    if (queryConfig.length >= 2) {
      addCandidate(candidates, relativeFile, text, block.start, {
        ruleId: "AP-TSR-301",
        message: `${block.name} exposes query/cache policy controls.`,
        evidence: queryConfig.slice(0, 8).join(", "),
      });
    }

    for (const imported of imports) {
      const used = imported.identifiers.filter((identifier) =>
        containsIdentifier(block.fullText, identifier),
      );
      if (used.length === 0) continue;

      if (moduleMatches(imported.moduleName, FORM_MODULES)) {
        addCandidate(candidates, relativeFile, text, block.start, {
          ruleId: "AP-TSR-302",
          message: `${block.name} exposes form-library types from ${imported.moduleName}.`,
          evidence: used.join(", "),
        });
      } else if (moduleMatches(imported.moduleName, QUERY_MODULES)) {
        addCandidate(candidates, relativeFile, text, block.start, {
          ruleId: "AP-TSR-301",
          message: `${block.name} exposes query-library types from ${imported.moduleName}.`,
          evidence: used.join(", "),
        });
      } else if (moduleMatches(imported.moduleName, ROUTER_STORE_MODULES)) {
        addCandidate(candidates, relativeFile, text, block.start, {
          ruleId: "AP-TSR-303",
          message: `${block.name} exposes router or state-store types from ${imported.moduleName}.`,
          evidence: used.join(", "),
        });
      } else if (moduleMatches(imported.moduleName, TRANSPORT_MODULES)) {
        const isError = used.some((identifier) => /Error$/.test(identifier));
        addCandidate(candidates, relativeFile, text, block.start, {
          ruleId: isError ? "AP-TSR-103" : "AP-TSR-101",
          message: `${block.name} exposes ${isError ? "infrastructure error" : "transport"} types from ${imported.moduleName}.`,
          evidence: used.join(", "),
        });
      } else if (
        !imported.moduleName.startsWith(".") &&
        !imported.moduleName.startsWith("react") &&
        !imported.moduleName.startsWith("@types/")
      ) {
        addCandidate(candidates, relativeFile, text, block.start, {
          ruleId: "AP-TSR-101",
          confidenceHint: "low",
          message: `${block.name} exposes imported types from ${imported.moduleName}; verify whether the boundary is intentionally transparent.`,
          evidence: used.join(", "),
        });
      }
    }
  }

  for (const imported of imports) {
    if (
      /(?:^|\/)(?:src|internal|private|implementation)(?:\/|$)/.test(
        imported.moduleName,
      )
    ) {
      addCandidate(candidates, relativeFile, text, imported.offset, {
        ruleId: "AP-TSR-304",
        message: `Deep import bypasses a supported entry point: ${imported.moduleName}.`,
      });
    }
  }

  for (const match of text.matchAll(
    /export\s+(?:async\s+)?function\s+(use[A-Z][A-Za-z0-9_$]*)[^\{]*\{/g,
  )) {
    const openingOffset = match.index + match[0].lastIndexOf("{");
    const closingOffset = findMatchingBrace(text, openingOffset);
    if (closingOffset === -1) continue;
    const body = text.slice(openingOffset + 1, closingOffset);
    if (
      /return\s+(?:useQuery|useInfiniteQuery|useMutation|useSWR|useLazyQuery)\s*\(/.test(
        body,
      )
    ) {
      addCandidate(candidates, relativeFile, text, match.index, {
        ruleId: "AP-TSR-301",
        message: `${match[1]} directly returns a query-library hook result.`,
      });
    }
  }

  for (const match of text.matchAll(
    /export\s+const\s+(use[A-Z][A-Za-z0-9_$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\(?\s*)?(useQuery|useInfiniteQuery|useMutation|useSWR|useLazyQuery)\s*\(/g,
  )) {
    addCandidate(candidates, relativeFile, text, match.index, {
      ruleId: "AP-TSR-301",
      message: `${match[1]} directly returns ${match[2]} without translating its contract.`,
    });
  }

  for (const match of text.matchAll(/\b(?:React\.)?Children\.only\s*\(|\bcloneElement\s*\(|\bchild\.type\b/g)) {
    addCandidate(candidates, relativeFile, text, match.index, {
      ruleId: "AP-TSR-207",
      confidenceHint: "low",
      message: "Component logic depends on a specific child shape or identity.",
    });
  }

  for (const match of text.matchAll(/\buseImperativeHandle\s*\(/g)) {
    const snippet = text.slice(match.index, match.index + 1200);
    const internalMethods = [
      ...snippet.matchAll(
        /\b(sync|flush|recalculate|resetCache|forceUpdate|getInternalState|rebuild|refreshLayout)\s*[:(]/g,
      ),
    ].map((entry) => entry[1]);
    const methodCount = [
      ...snippet.matchAll(/\b[A-Za-z_$][\w$]*\s*:\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g),
    ].length;
    if (internalMethods.length > 0 || methodCount >= 4) {
      addCandidate(candidates, relativeFile, text, match.index, {
        ruleId: "AP-TSR-204",
        message: "Imperative handle exposes a broad or implementation-oriented command surface.",
        evidence:
          internalMethods.join(", ") || `${methodCount} apparent methods`,
      });
    }
  }

  const passThroughPatterns = [
    /export\s+function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{\s*return\s*\(?\s*<([A-Z][\w$]*)\s+\{\.\.\.([A-Za-z_$][\w$]*)\}\s*\/?>(?:\s*<\/\3>)?\s*\)?\s*;?\s*\}/g,
    /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\(([^)]*)\)\s*=>\s*\(?\s*<([A-Z][\w$]*)\s+\{\.\.\.([A-Za-z_$][\w$]*)\}\s*\/?>(?:\s*<\/\3>)?\s*\)?\s*;?/g,
  ];
  const externalComponentNames = new Set(
    imports
      .filter((entry) => !entry.moduleName.startsWith("."))
      .flatMap((entry) => entry.identifiers),
  );
  for (const pattern of passThroughPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (!externalComponentNames.has(match[3])) continue;
      addCandidate(candidates, relativeFile, text, match.index, {
        ruleId: "AP-TSR-401",
        message: `${match[1]} appears to pass props straight through to external component ${match[3]}.`,
      });
    }
  }

  if (options.includeTests && isTestFile(relativeFile)) {
    for (const match of text.matchAll(
      /\.querySelector\s*\(\s*["']\.|getElementsByClassName\s*\(|container\.firstChild|container\.children\[/g,
    )) {
      addCandidate(candidates, relativeFile, text, match.index, {
        ruleId: "AP-TSR-404",
        confidenceHint: "low",
        message: "Test depends on internal DOM structure or private class names.",
      });
    }
  }

  return candidates;
}

export async function scanPath(target = ".", suppliedOptions = {}) {
  const options = {
    includeTests: false,
    maxFiles: 10000,
    ...suppliedOptions,
  };
  const absoluteTarget = path.resolve(target);
  const root = (await fs.stat(absoluteTarget)).isDirectory()
    ? absoluteTarget
    : path.dirname(absoluteTarget);
  const files = await collectFiles(absoluteTarget, options);
  const candidates = [];
  const errors = [];

  for (const filePath of files) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 2_000_000) {
        errors.push({
          file: path.relative(root, filePath) || path.basename(filePath),
          error: "Skipped file larger than 2 MB",
        });
        continue;
      }
      const text = await fs.readFile(filePath, "utf8");
      const relativeFile = path.relative(root, filePath) || path.basename(filePath);
      candidates.push(...analyzeFile(text, relativeFile, options));
    } catch (error) {
      errors.push({
        file: path.relative(root, filePath) || path.basename(filePath),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  candidates.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.ruleId.localeCompare(b.ruleId),
  );

  return {
    schemaVersion: "1.0",
    target: absoluteTarget,
    filesScanned: files.length,
    candidateCount: candidates.length,
    candidates,
    errors,
    notice:
      "Candidates are investigation leads. Validate real consumers, change amplification, ownership, and counterevidence before reporting a finding.",
  };
}

export function renderText(result) {
  const lines = [
    "TypeScript/React Abstraction Police — candidate scan",
    `Target: ${result.target}`,
    `Files scanned: ${result.filesScanned}`,
    `Candidates: ${result.candidateCount}`,
    "",
  ];

  for (const candidate of result.candidates) {
    lines.push(
      `${candidate.ruleId} [${candidate.confidenceHint}] ${candidate.file}:${candidate.line}`,
    );
    lines.push(`  ${candidate.message}`);
    if (candidate.evidence) lines.push(`  Evidence: ${candidate.evidence}`);
  }

  if (result.candidates.length === 0) {
    lines.push("No heuristic candidates found in the scanned files.");
  }

  if (result.errors.length > 0) {
    lines.push("", "Skipped/errors:");
    for (const error of result.errors) {
      lines.push(`  ${error.file}: ${error.error}`);
    }
  }

  lines.push("", result.notice);
  return `${lines.join("\n")}\n`;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }

    const result = await scanPath(options.target, options);
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (options.format === "jsonl") {
      for (const candidate of result.candidates) {
        process.stdout.write(`${JSON.stringify(candidate)}\n`);
      }
    } else {
      process.stdout.write(renderText(result));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`abstraction-police: ${message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  await main();
}
