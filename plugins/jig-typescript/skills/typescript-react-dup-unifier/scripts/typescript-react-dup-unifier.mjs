#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const require = createRequire(import.meta.url);
const THIS_FILE = fileURLToPath(import.meta.url);

const DEFAULTS = Object.freeze({
  minScore: 0.68,
  minTokens: 32,
  minLines: 3,
  maxResults: 100,
  maxFileBytes: 1_500_000,
  includeTests: false,
  includeStories: false,
  includeTypes: true,
  includeGenerated: false,
  exclude: [],
  json: null,
  markdown: null,
  failAbove: null,
  quiet: false,
});

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.vercel',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'coverage',
  'out',
  'vendor',
]);

const FUNCTION_WRAPPERS = new Set([
  'memo',
  'React.memo',
  'forwardRef',
  'React.forwardRef',
  'observer',
  'mobx.observer',
  'withRouter',
]);

const GENERIC_NAME_TERMS = new Set([
  'use', 'get', 'set', 'create', 'make', 'build', 'handle', 'on', 'with',
  'component', 'hook', 'service', 'util', 'helper', 'type', 'interface',
  'props', 'options', 'config', 'data', 'item', 'list', 'view', 'base',
]);

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const root = path.resolve(options.root ?? process.cwd());
  if (!fs.existsSync(root)) {
    throw new Error(`Target does not exist: ${root}`);
  }

  const ts = loadTypeScript(root);
  const sourceFiles = listSourceFiles(root, options);
  const parseWarnings = [];
  const units = [];

  for (const file of sourceFiles) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > options.maxFileBytes) {
      if (stat.size > options.maxFileBytes) {
        parseWarnings.push({
          file: toRelative(root, file),
          message: `Skipped file larger than ${options.maxFileBytes} bytes`,
        });
      }
      continue;
    }

    const text = fs.readFileSync(file, 'utf8');
    if (!options.includeGenerated && looksGenerated(file, text)) {
      continue;
    }

    const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
    if (sourceFile.parseDiagnostics?.length) {
      for (const diagnostic of sourceFile.parseDiagnostics.slice(0, 5)) {
        const position = diagnostic.start ?? 0;
        const loc = sourceFile.getLineAndCharacterOfPosition(position);
        parseWarnings.push({
          file: toRelative(root, file),
          line: loc.line + 1,
          column: loc.character + 1,
          message: flattenDiagnostic(ts, diagnostic.messageText),
        });
      }
    }

    const fileContext = buildFileContext(ts, sourceFile, root, file);
    const discovered = extractUnits(ts, sourceFile, fileContext, options);
    for (const unit of discovered) {
      const analyzed = analyzeUnit(ts, sourceFile, unit, fileContext);
      if (analyzed.tokenCount < options.minTokens || analyzed.lineCount < options.minLines) {
        continue;
      }
      units.push(analyzed);
    }
  }

  const scan = buildScan(root, sourceFiles, units, parseWarnings, options);
  writeOutputs(scan, options);

  if (!options.quiet && (options.json || options.markdown)) {
    console.error(
      `typescript-react-dup-unifier: scanned ${scan.summary.filesScanned} files, analyzed ` +
      `${scan.summary.unitsAnalyzed} abstractions, emitted ${scan.summary.candidatesEmitted} candidates`,
    );
  }

  if (
    options.failAbove != null &&
    scan.candidates.some((candidate) => candidate.score >= options.failAbove)
  ) {
    process.exitCode = 2;
  }
}

function parseOptions(argv) {
  let configPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--config') {
      configPath = argv[index + 1];
      break;
    }
  }

  let config = {};
  if (configPath) {
    const resolved = path.resolve(configPath);
    config = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  }

  const options = {
    ...DEFAULTS,
    ...config,
    exclude: [...(DEFAULTS.exclude ?? []), ...(config.exclude ?? [])],
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value after ${arg}`);
      }
      return argv[index];
    };

    switch (arg) {
      case '--config':
        index += 1;
        break;
      case '--min-score':
        options.minScore = parseNumber(next(), arg, 0, 1);
        break;
      case '--min-tokens':
        options.minTokens = parseInteger(next(), arg, 1);
        break;
      case '--min-lines':
        options.minLines = parseInteger(next(), arg, 1);
        break;
      case '--max-results':
        options.maxResults = parseInteger(next(), arg, 1);
        break;
      case '--max-file-bytes':
        options.maxFileBytes = parseInteger(next(), arg, 1);
        break;
      case '--include-tests':
        options.includeTests = true;
        break;
      case '--include-stories':
        options.includeStories = true;
        break;
      case '--include-generated':
        options.includeGenerated = true;
        break;
      case '--no-types':
        options.includeTypes = false;
        break;
      case '--exclude':
        options.exclude.push(next());
        break;
      case '--json':
        options.json = next();
        break;
      case '--markdown':
        options.markdown = next();
        break;
      case '--fail-above':
        options.failAbove = parseNumber(next(), arg, 0, 1);
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
      case '-v':
        options.version = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new Error(`Expected at most one target path, received: ${positional.join(', ')}`);
  }
  options.root = positional[0] ?? options.root ?? null;

  if (options.json === '-' && options.markdown === '-') {
    throw new Error('Only one output may target stdout ("-")');
  }

  return options;
}

function parseNumber(value, flag, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseInteger(value, flag, min) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${flag} must be an integer >= ${min}`);
  }
  return parsed;
}

function helpText() {
  return `TypeScript/React Dup Unifier ${VERSION}\n\n` +
    `Usage:\n` +
    `  node typescript-react-dup-unifier.mjs [target] [options]\n\n` +
    `Options:\n` +
    `  --config <file>          Load JSON configuration\n` +
    `  --min-score <0..1>       Candidate threshold (default: ${DEFAULTS.minScore})\n` +
    `  --min-tokens <n>         Ignore smaller abstractions (default: ${DEFAULTS.minTokens})\n` +
    `  --min-lines <n>          Ignore shorter abstractions (default: ${DEFAULTS.minLines})\n` +
    `  --max-results <n>        Maximum emitted candidates (default: ${DEFAULTS.maxResults})\n` +
    `  --include-tests          Include *.test.*, *.spec.*, and __tests__\n` +
    `  --include-stories        Include Storybook stories\n` +
    `  --include-generated      Include generated-looking files\n` +
    `  --no-types               Skip interfaces and type aliases\n` +
    `  --exclude <glob>         Add a path exclusion; repeatable\n` +
    `  --json <file|->          Write machine-readable JSON\n` +
    `  --markdown <file|->      Write a review-oriented Markdown report\n` +
    `  --fail-above <0..1>      Exit 2 when a candidate reaches this score\n` +
    `  --quiet                  Suppress the stderr summary\n` +
    `  -h, --help               Show help\n` +
    `  -v, --version            Show version\n\n` +
    `When no output flag is supplied, Markdown is written to stdout.\n`;
}

function loadTypeScript(root) {
  const resolutionPaths = [root, process.cwd(), path.dirname(THIS_FILE)];
  try {
    const resolved = require.resolve('typescript', { paths: resolutionPaths });
    return require(resolved);
  } catch {
    // Continue to global resolution.
  }

  const candidates = [];
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    candidates.push(path.join(globalRoot, 'typescript'));
  } catch {
    // npm is optional.
  }

  candidates.push(
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'typescript'),
    '/usr/local/lib/node_modules/typescript',
    '/usr/lib/node_modules/typescript',
  );

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next location.
    }
  }

  throw new Error(
    'Unable to load TypeScript. Use the repository\'s existing typescript dependency or make a global TypeScript installation available. The scanner never installs packages.',
  );
}

function listSourceFiles(root, options) {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return isEligibleSource(root, root, options) ? [root] : [];
  }

  let files = null;
  try {
    const gitRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const output = execFileSync(
      'git',
      ['-C', gitRoot, 'ls-files', '-co', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const prefix = ensureTrailingSeparator(path.resolve(root));
    files = output
      .split('\0')
      .filter(Boolean)
      .map((entry) => path.resolve(gitRoot, entry))
      .filter((file) => file === path.resolve(root) || file.startsWith(prefix));
  } catch {
    files = walkDirectory(root);
  }

  return [...new Set(files)]
    .filter((file) => isEligibleSource(root, file, options))
    .sort((a, b) => a.localeCompare(b));
}

function walkDirectory(root) {
  const results = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function isEligibleSource(root, file, options) {
  const normalized = toPosix(toRelative(root, file));
  const basename = path.basename(file);
  const segments = normalized.split('/');

  if (!/\.tsx?$/i.test(basename) || /\.d\.ts$/i.test(basename)) {
    return false;
  }
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) {
    return false;
  }
  if (!options.includeTests && isTestPath(normalized)) {
    return false;
  }
  if (!options.includeStories && /(?:^|\/)?.+\.stories\.tsx?$/i.test(normalized)) {
    return false;
  }
  if (options.exclude.some((pattern) => matchesGlob(normalized, pattern))) {
    return false;
  }
  return true;
}

function isTestPath(normalized) {
  return /(?:^|\/)(__tests__|test|tests)(?:\/|$)/i.test(normalized) ||
    /\.(?:test|spec)\.tsx?$/i.test(normalized);
}

function looksGenerated(file, text) {
  const normalized = toPosix(file).toLowerCase();
  if (
    normalized.includes('/generated/') ||
    normalized.includes('/__generated__/') ||
    /\.(?:generated|gen)\.tsx?$/.test(normalized)
  ) {
    return true;
  }
  const header = text.slice(0, 800).toLowerCase();
  return header.includes('@generated') ||
    header.includes('code generated') ||
    header.includes('do not edit this file');
}

function matchesGlob(value, pattern) {
  const normalizedPattern = toPosix(String(pattern));
  if (!normalizedPattern.includes('*') && !normalizedPattern.includes('?')) {
    return value.includes(normalizedPattern);
  }
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexSource = escaped
    .replace(/\*\*/g, '§§DOUBLESTAR§§')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/§§DOUBLESTAR§§/g, '.*');
  return new RegExp(`^${regexSource}$`).test(value) || new RegExp(regexSource).test(value);
}

function buildFileContext(ts, sourceFile, root, file) {
  const importMap = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : statement.moduleSpecifier.getText(sourceFile);
    const clause = statement.importClause;
    if (clause.name) {
      importMap.set(clause.name.text, moduleName);
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        importMap.set(clause.namedBindings.name.text, moduleName);
      } else {
        for (const element of clause.namedBindings.elements) {
          importMap.set(element.name.text, moduleName);
        }
      }
    }
  }

  const useClient = sourceFile.statements.some((statement, index) => {
    if (index > 5 || !ts.isExpressionStatement(statement)) {
      return false;
    }
    return ts.isStringLiteral(statement.expression) && statement.expression.text === 'use client';
  });

  return {
    root,
    file,
    relativeFile: toPosix(toRelative(root, file)),
    importMap,
    useClient,
    packageName: findPackageName(root, file),
  };
}

const packageNameCache = new Map();
function findPackageName(root, file) {
  let directory = path.dirname(file);
  const rootResolved = path.resolve(root);
  const visited = [];

  while (directory.startsWith(rootResolved)) {
    if (packageNameCache.has(directory)) {
      const cached = packageNameCache.get(directory);
      for (const item of visited) packageNameCache.set(item, cached);
      return cached;
    }
    visited.push(directory);
    const packageFile = path.join(directory, 'package.json');
    if (fs.existsSync(packageFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
        const value = pkg.name || toPosix(toRelative(rootResolved, directory)) || path.basename(rootResolved);
        for (const item of visited) packageNameCache.set(item, value);
        return value;
      } catch {
        // Continue upward.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  const fallback = path.basename(rootResolved);
  for (const item of visited) packageNameCache.set(item, fallback);
  return fallback;
}

function extractUnits(ts, sourceFile, fileContext, options) {
  const units = [];
  const add = (node, meta) => {
    if (!node || !meta.name) return;
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const startLoc = sourceFile.getLineAndCharacterOfPosition(start);
    const endLoc = sourceFile.getLineAndCharacterOfPosition(end);
    units.push({
      node,
      functionNode: meta.functionNode ?? null,
      name: meta.name,
      qualifiedName: meta.qualifiedName ?? meta.name,
      kind: meta.kind,
      family: meta.family,
      exported: meta.exported ?? isExported(ts, node),
      start,
      end,
      startLine: startLoc.line + 1,
      endLine: endLoc.line + 1,
      fileContext,
    });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      const kind = classifyCallable(ts, name, statement, sourceFile);
      add(statement, {
        name,
        kind,
        family: familyForKind(kind),
        functionNode: statement,
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = isExported(ts, statement);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const name = declaration.name.text;
        const functionNode = unwrapFunctionInitializer(ts, declaration.initializer);
        if (functionNode) {
          const kind = classifyCallable(ts, name, functionNode, sourceFile);
          add(declaration, {
            name,
            kind,
            family: familyForKind(kind),
            functionNode,
            exported,
          });
          continue;
        }

        const specialKind = classifyNonCallable(ts, name, declaration.initializer, sourceFile);
        if (specialKind) {
          add(declaration, {
            name,
            kind: specialKind,
            family: familyForKind(specialKind),
            exported,
          });
        }
      }
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const className = statement.name.text;
      if (isReactClassComponent(ts, statement, sourceFile)) {
        add(statement, {
          name: className,
          kind: 'component',
          family: 'component',
        });
      } else {
        for (const member of statement.members) {
          if (!ts.isMethodDeclaration(member) || !member.name) continue;
          const methodName = propertyNameText(ts, member.name, sourceFile);
          if (!methodName || methodName === 'constructor') continue;
          add(member, {
            name: methodName,
            qualifiedName: `${className}.${methodName}`,
            kind: 'method',
            family: 'callable',
            functionNode: member,
            exported: isExported(ts, statement),
          });
        }
      }
      continue;
    }

    if (options.includeTypes && ts.isInterfaceDeclaration(statement)) {
      add(statement, {
        name: statement.name.text,
        kind: 'interface',
        family: 'type',
      });
      continue;
    }

    if (options.includeTypes && ts.isTypeAliasDeclaration(statement)) {
      add(statement, {
        name: statement.name.text,
        kind: 'type',
        family: 'type',
      });
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      const functionNode = unwrapFunctionInitializer(ts, statement.expression);
      if (functionNode) {
        const inferred = functionNode.name && ts.isIdentifier(functionNode.name)
          ? functionNode.name.text
          : path.basename(fileContext.file, path.extname(fileContext.file));
        const kind = classifyCallable(ts, inferred, functionNode, sourceFile);
        add(statement, {
          name: inferred,
          kind,
          family: familyForKind(kind),
          functionNode,
          exported: true,
        });
      }
    }
  }

  return units;
}

function classifyCallable(ts, name, node, sourceFile) {
  if (/^use[A-Z0-9_]/.test(name)) return 'hook';
  if (/reducer$/i.test(name)) return 'state';
  if ((/^[A-Z]/.test(name) && containsJsx(ts, node)) || isReactWrapperNode(ts, node, sourceFile)) {
    return 'component';
  }
  return 'function';
}

function classifyNonCallable(ts, name, initializer, sourceFile) {
  const callee = ts.isCallExpression(initializer) ? calleeName(ts, initializer.expression, sourceFile) : '';
  if (
    /(?:schema|validator|codec|contract|dto)$/i.test(name) ||
    /(?:^|\.)(?:object|union|intersection|record|tuple|lazy)$/i.test(callee) && /^(?:z|yup|v|valibot|io-ts)\./i.test(callee)
  ) {
    return 'schema';
  }
  if (
    /(?:reducer|slice|store|machine)$/i.test(name) ||
    /(?:createSlice|createReducer|createStore|createMachine|setup)$/i.test(callee)
  ) {
    return 'state';
  }
  if (
    ts.isObjectLiteralExpression(initializer) &&
    /(?:config|options|adapter|registry|map|definition|columns|routes)$/i.test(name)
  ) {
    return 'object';
  }
  return null;
}

function familyForKind(kind) {
  switch (kind) {
    case 'component': return 'component';
    case 'hook': return 'hook';
    case 'state': return 'state';
    case 'schema': return 'schema';
    case 'object': return 'object';
    case 'type':
    case 'interface': return 'type';
    default: return 'callable';
  }
}

function unwrapFunctionInitializer(ts, node, depth = 0) {
  if (!node || depth > 5) return null;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))
  ) {
    return unwrapFunctionInitializer(ts, node.expression, depth + 1);
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(ts, node.expression, node.getSourceFile());
    if (FUNCTION_WRAPPERS.has(name) || name.endsWith('.memo') || name.endsWith('.forwardRef')) {
      for (const argument of [...node.arguments].reverse()) {
        const unwrapped = unwrapFunctionInitializer(ts, argument, depth + 1);
        if (unwrapped) return unwrapped;
      }
    }
  }
  return null;
}

function isReactWrapperNode(ts, node, sourceFile) {
  let current = node;
  if (ts.isVariableDeclaration(node)) current = node.initializer;
  if (!current || !ts.isCallExpression(current)) return false;
  const name = calleeName(ts, current.expression, sourceFile);
  return name.endsWith('memo') || name.endsWith('forwardRef');
}

function isReactClassComponent(ts, node, sourceFile) {
  return (node.heritageClauses ?? []).some((clause) =>
    clause.types.some((type) => {
      const text = type.expression.getText(sourceFile);
      return text === 'Component' || text === 'PureComponent' ||
        text.endsWith('.Component') || text.endsWith('.PureComponent');
    }),
  );
}

function containsJsx(ts, node) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isJsxFragment(current)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function analyzeUnit(ts, sourceFile, unit, fileContext) {
  const shapeTokens = [];
  const histogram = new Map();
  const features = {
    calls: new Set(),
    hooks: new Set(),
    jsxTags: new Set(),
    jsxAttributes: new Set(),
    propKeys: new Set(),
    typeRefs: new Set(),
    imports: new Set(),
    literals: new Set(),
    memberKeys: new Set(),
    semanticTerms: new Set(splitIdentifier(unit.name)),
    control: {
      if: 0,
      switch: 0,
      loop: 0,
      try: 0,
      conditional: 0,
      return: 0,
      throw: 0,
      await: 0,
      yield: 0,
    },
    jsxNodeCount: 0,
    async: false,
    useClient: fileContext.useClient,
  };

  const parameterNames = new Set();
  if (unit.functionNode?.parameters) {
    for (const parameter of unit.functionNode.parameters) {
      collectBindingNames(ts, parameter.name, parameterNames, features.propKeys, sourceFile);
    }
    features.async = hasModifier(ts, unit.functionNode, ts.SyntaxKind.AsyncKeyword);
  }

  const visit = (node) => {
    histogram.set(node.kind, (histogram.get(node.kind) ?? 0) + 1);
    shapeTokens.push(`n${node.kind}`);

    if (ts.isIdentifier(node)) {
      const role = identifierRole(ts, node);
      shapeTokens.push(`i:${role}`);
      if (role === 'property' || role === 'member' || role === 'jsx') {
        addSemantic(features, node.text);
      }
      if (fileContext.importMap.has(node.text)) {
        features.imports.add(fileContext.importMap.get(node.text));
      }
      const parent = node.parent;
      if (
        role === 'property' &&
        parent && ts.isPropertyAccessExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parameterNames.has(parent.expression.text)
      ) {
        features.propKeys.add(node.text);
      }
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(ts, node.expression, sourceFile);
      if (name) {
        const concise = conciseCallee(name);
        features.calls.add(concise);
        addSemantic(features, concise);
        if (/^use[A-Z0-9_]/.test(concise)) features.hooks.add(concise);
      }
      shapeTokens.push(`call:${node.arguments.length}`);
    }

    if (ts.isPropertyAccessExpression(node)) {
      features.memberKeys.add(node.name.text);
    }

    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) ||
        ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) ||
        ts.isMethodSignature(node) || ts.isMethodDeclaration(node) || ts.isEnumMember(node)) {
      if (node.name) {
        const member = propertyNameText(ts, node.name, sourceFile);
        if (member) {
          features.memberKeys.add(member);
          addSemantic(features, member);
        }
      }
    }

    if (ts.isTypeReferenceNode(node)) {
      const typeName = node.typeName.getText(sourceFile);
      features.typeRefs.add(typeName);
      addSemantic(features, typeName);
    }

    if (ts.isStringLiteralLike(node)) {
      features.literals.add(`str:${truncate(node.text, 48)}`);
      shapeTokens.push('lit:string');
    } else if (ts.isTemplateExpression(node)) {
      const staticShape = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
        .join('${…}');
      features.literals.add(`template:${truncate(staticShape, 64)}`);
      shapeTokens.push('lit:template');
    } else if (ts.isNumericLiteral(node)) {
      features.literals.add(`num:${node.text}`);
      shapeTokens.push('lit:number');
    } else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      features.literals.add(node.kind === ts.SyntaxKind.TrueKeyword ? 'bool:true' : 'bool:false');
      shapeTokens.push('lit:boolean');
    }

    if (ts.isBinaryExpression(node)) {
      shapeTokens.push(`op:${node.operatorToken.kind}`);
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      shapeTokens.push(`op:${node.operator}`);
    }

    if (ts.isIfStatement(node)) features.control.if += 1;
    if (ts.isSwitchStatement(node)) features.control.switch += 1;
    if (
      ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) || ts.isDoStatement(node)
    ) features.control.loop += 1;
    if (ts.isTryStatement(node)) features.control.try += 1;
    if (ts.isConditionalExpression(node)) features.control.conditional += 1;
    if (ts.isReturnStatement(node)) features.control.return += 1;
    if (ts.isThrowStatement(node)) features.control.throw += 1;
    if (ts.isAwaitExpression(node)) features.control.await += 1;
    if (ts.isYieldExpression(node)) features.control.yield += 1;

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      features.jsxTags.add(tag);
      features.jsxNodeCount += 1;
      shapeTokens.push(`jsx:${/^[a-z]/.test(tag) ? 'intrinsic' : 'component'}`);
      addSemantic(features, tag);
      for (const property of node.attributes.properties) {
        if (ts.isJsxAttribute(property)) {
          const attribute = property.name.getText(sourceFile);
          features.jsxAttributes.add(attribute);
          if (attribute.startsWith('aria-') || attribute === 'role' || attribute === 'tabIndex') {
            features.memberKeys.add(attribute);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(unit.node);

  const sourceText = unit.node.getText(sourceFile);
  const normalizedText = sourceText.replace(/\s+/g, '');
  const shapeShingles = makeShingles(shapeTokens, 4);
  const startLine = unit.startLine;
  const endLine = unit.endLine;

  return {
    key: `${fileContext.relativeFile}:${startLine}:${unit.qualifiedName}`,
    name: unit.name,
    qualifiedName: unit.qualifiedName,
    kind: unit.kind,
    family: unit.family,
    exported: unit.exported,
    file: fileContext.relativeFile,
    package: fileContext.packageName,
    startLine,
    endLine,
    lineCount: Math.max(1, endLine - startLine + 1),
    tokenCount: shapeTokens.length,
    textHash: sha1(normalizedText),
    structuralHash: sha1(shapeTokens.join('|')),
    shapeShingles,
    shapeTokens,
    histogram,
    features,
  };
}

function collectBindingNames(ts, bindingName, parameterNames, propKeys, sourceFile) {
  if (ts.isIdentifier(bindingName)) {
    parameterNames.add(bindingName.text);
    return;
  }
  if (ts.isObjectBindingPattern(bindingName)) {
    for (const element of bindingName.elements) {
      const key = element.propertyName
        ? propertyNameText(ts, element.propertyName, sourceFile)
        : propertyNameText(ts, element.name, sourceFile);
      if (key) propKeys.add(key);
      collectBindingNames(ts, element.name, parameterNames, propKeys, sourceFile);
    }
    return;
  }
  if (ts.isArrayBindingPattern(bindingName)) {
    for (const element of bindingName.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingNames(ts, element.name, parameterNames, propKeys, sourceFile);
      }
    }
  }
}

function identifierRole(ts, node) {
  const parent = node.parent;
  if (!parent) return 'value';
  if (
    (parent.name === node) &&
    (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) || ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) || ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent))
  ) return 'declaration';
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return 'property';
  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) && parent.name === node
  ) return 'member';
  if (
    (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) &&
    parent.tagName === node
  ) return 'jsx';
  if (ts.isTypeReferenceNode(parent)) return 'type';
  return 'value';
}

function addSemantic(features, value) {
  for (const term of splitIdentifier(value)) {
    if (term.length >= 2) features.semanticTerms.add(term);
  }
}

function buildScan(root, sourceFiles, units, parseWarnings, options) {
  const candidatesAll = discoverCandidates(units, options);
  const candidates = candidatesAll.slice(0, options.maxResults).map((candidate) => serializeCandidate(candidate));
  const clusters = buildClusters(candidates);

  return {
    tool: 'typescript-react-dup-unifier',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    root,
    options: {
      minScore: options.minScore,
      minTokens: options.minTokens,
      minLines: options.minLines,
      maxResults: options.maxResults,
      includeTests: options.includeTests,
      includeStories: options.includeStories,
      includeTypes: options.includeTypes,
      includeGenerated: options.includeGenerated,
      exclude: options.exclude,
    },
    summary: {
      filesScanned: sourceFiles.length,
      unitsAnalyzed: units.length,
      candidatesFound: candidatesAll.length,
      candidatesEmitted: candidates.length,
      clusters: clusters.length,
      parseWarnings: parseWarnings.length,
    },
    parseWarnings,
    clusters,
    candidates,
  };
}

function discoverCandidates(units, options) {
  const familyUnits = new Map();
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (!familyUnits.has(unit.family)) familyUnits.set(unit.family, []);
    familyUnits.get(unit.family).push(index);
  }

  const documentFrequency = new Map();
  for (const [family, indexes] of familyUnits) {
    for (const index of indexes) {
      for (const shingle of units[index].shapeShingles) {
        const key = `${family}|${shingle}`;
        documentFrequency.set(key, (documentFrequency.get(key) ?? 0) + 1);
      }
    }
  }

  const pairKeys = new Set();
  const addPair = (left, right) => {
    if (left === right) return;
    const a = Math.min(left, right);
    const b = Math.max(left, right);
    pairKeys.add(`${a}:${b}`);
  };

  for (const [family, indexes] of familyUnits) {
    if (indexes.length <= 260) {
      for (let i = 0; i < indexes.length; i += 1) {
        for (let j = i + 1; j < indexes.length; j += 1) {
          const left = units[indexes[i]];
          const right = units[indexes[j]];
          if (sizeRatio(left, right) >= 0.45) addPair(indexes[i], indexes[j]);
        }
      }
      continue;
    }

    const anchorIndex = new Map();
    const familyLimit = Math.max(18, Math.ceil(indexes.length * 0.18));
    for (const index of indexes) {
      const unit = units[index];
      const anchors = [...unit.shapeShingles]
        .map((shingle) => ({
          shingle,
          frequency: documentFrequency.get(`${family}|${shingle}`) ?? Number.MAX_SAFE_INTEGER,
        }))
        .filter((entry) => entry.frequency <= familyLimit)
        .sort((a, b) => a.frequency - b.frequency || a.shingle.localeCompare(b.shingle))
        .slice(0, 24);

      for (const { shingle } of anchors) {
        const key = `${family}|${shingle}`;
        if (!anchorIndex.has(key)) anchorIndex.set(key, []);
        anchorIndex.get(key).push(index);
      }
    }

    for (const bucket of anchorIndex.values()) {
      if (bucket.length > 420) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          if (sizeRatio(units[bucket[i]], units[bucket[j]]) >= 0.45) {
            addPair(bucket[i], bucket[j]);
          }
        }
      }
    }

    const nameIndex = new Map();
    for (const index of indexes) {
      const terms = splitIdentifier(units[index].name)
        .filter((term) => term.length >= 4 && !GENERIC_NAME_TERMS.has(term));
      for (const term of terms.slice(0, 4)) {
        const key = `${family}|name:${term}`;
        if (!nameIndex.has(key)) nameIndex.set(key, []);
        nameIndex.get(key).push(index);
      }
    }
    for (const bucket of nameIndex.values()) {
      if (bucket.length > 120) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) addPair(bucket[i], bucket[j]);
      }
    }
  }

  const exactIndex = new Map();
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const key = `${unit.family}|${unit.structuralHash}`;
    if (!exactIndex.has(key)) exactIndex.set(key, []);
    exactIndex.get(key).push(index);
  }
  for (const bucket of exactIndex.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) addPair(bucket[i], bucket[j]);
    }
  }

  const candidates = [];
  for (const key of pairKeys) {
    const [leftIndex, rightIndex] = key.split(':').map(Number);
    const left = units[leftIndex];
    const right = units[rightIndex];
    if (left.family !== right.family) continue;
    if (sizeRatio(left, right) < 0.45) continue;

    const metrics = similarityMetrics(left, right);
    if (metrics.shape < 0.42 && left.textHash !== right.textHash) continue;
    if (metrics.score < options.minScore) continue;

    candidates.push({
      left,
      right,
      metrics,
      score: metrics.score,
      relationship: classifyRelationship(left, right, metrics),
      divergence: compareFeatures(left, right),
    });
  }

  candidates.sort((a, b) =>
    b.score - a.score ||
    b.metrics.shape - a.metrics.shape ||
    a.left.key.localeCompare(b.left.key) ||
    a.right.key.localeCompare(b.right.key),
  );
  return candidates;
}

function similarityMetrics(left, right) {
  const shapeJaccard = jaccard(left.shapeShingles, right.shapeShingles);
  const shapeContainment = containment(left.shapeShingles, right.shapeShingles);
  const shape = 0.72 * shapeJaccard + 0.28 * shapeContainment;
  const histogram = cosineMaps(left.histogram, right.histogram);
  const size = sizeRatio(left, right);
  const control = controlSimilarity(left.features.control, right.features.control);
  const semantic = jaccard(left.features.semanticTerms, right.features.semanticTerms);
  const behavior = behaviorSimilarity(left.features, right.features);

  let weights;
  switch (left.family) {
    case 'component':
      weights = { shape: 0.42, histogram: 0.08, size: 0.08, control: 0.07, behavior: 0.25, semantic: 0.10 };
      break;
    case 'hook':
      weights = { shape: 0.45, histogram: 0.08, size: 0.08, control: 0.09, behavior: 0.22, semantic: 0.08 };
      break;
    case 'type':
      weights = { shape: 0.50, histogram: 0.08, size: 0.10, control: 0.02, behavior: 0.20, semantic: 0.10 };
      break;
    case 'schema':
    case 'object':
      weights = { shape: 0.47, histogram: 0.08, size: 0.10, control: 0.03, behavior: 0.22, semantic: 0.10 };
      break;
    default:
      weights = { shape: 0.50, histogram: 0.10, size: 0.10, control: 0.10, behavior: 0.12, semantic: 0.08 };
  }

  const score = clamp01(
    weights.shape * shape +
    weights.histogram * histogram +
    weights.size * size +
    weights.control * control +
    weights.behavior * behavior +
    weights.semantic * semantic,
  );

  return {
    score: round(score),
    shape: round(shape),
    shapeJaccard: round(shapeJaccard),
    shapeContainment: round(shapeContainment),
    histogram: round(histogram),
    size: round(size),
    control: round(control),
    behavior: round(behavior),
    semantic: round(semantic),
  };
}

function behaviorSimilarity(left, right) {
  const signals = [
    [left.calls, right.calls, 0.30],
    [left.hooks, right.hooks, 0.20],
    [left.jsxTags, right.jsxTags, 0.14],
    [left.jsxAttributes, right.jsxAttributes, 0.08],
    [left.propKeys, right.propKeys, 0.10],
    [left.memberKeys, right.memberKeys, 0.08],
    [left.typeRefs, right.typeRefs, 0.05],
    [left.imports, right.imports, 0.05],
  ];

  let weighted = 0;
  let totalWeight = 0;
  for (const [a, b, weight] of signals) {
    if (a.size === 0 && b.size === 0) continue;
    weighted += weight * jaccard(a, b);
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0.5 : weighted / totalWeight;
}

function controlSimilarity(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let difference = 0;
  let magnitude = 0;
  for (const key of keys) {
    const a = left[key] ?? 0;
    const b = right[key] ?? 0;
    difference += Math.abs(a - b);
    magnitude += Math.max(a, b);
  }
  return magnitude === 0 ? 1 : clamp01(1 - difference / magnitude);
}

function classifyRelationship(left, right, metrics) {
  if (left.textHash === right.textHash) return 'exact-clone';
  if (left.structuralHash === right.structuralHash && metrics.behavior >= 0.72) return 'renamed-clone';
  if (metrics.shape >= 0.84 && metrics.behavior < 0.52) return 'shared-shell-divergent-core';
  if (metrics.score >= 0.84) return 'near-duplicate';
  if (metrics.shape >= 0.72) return 'parallel-abstraction';
  return 'possible-pattern';
}

function compareFeatures(left, right) {
  const a = left.features;
  const b = right.features;
  const setDiff = (x, y) => ({
    onlyLeft: limitedDifference(x, y),
    onlyRight: limitedDifference(y, x),
  });

  return {
    calls: setDiff(a.calls, b.calls),
    hooks: setDiff(a.hooks, b.hooks),
    jsxTags: setDiff(a.jsxTags, b.jsxTags),
    jsxAttributes: setDiff(a.jsxAttributes, b.jsxAttributes),
    propKeys: setDiff(a.propKeys, b.propKeys),
    memberKeys: setDiff(a.memberKeys, b.memberKeys),
    typeRefs: setDiff(a.typeRefs, b.typeRefs),
    imports: setDiff(a.imports, b.imports),
    literals: setDiff(a.literals, b.literals),
    controlDelta: controlDelta(a.control, b.control),
    asyncMismatch: a.async !== b.async,
    clientBoundaryMismatch: a.useClient !== b.useClient,
    lineDelta: left.lineCount - right.lineCount,
    tokenDelta: left.tokenCount - right.tokenCount,
  };
}

function limitedDifference(left, right, limit = 12) {
  return [...left].filter((value) => !right.has(value)).sort().slice(0, limit);
}

function controlDelta(left, right) {
  const result = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const delta = (left[key] ?? 0) - (right[key] ?? 0);
    if (delta !== 0) result[key] = delta;
  }
  return result;
}

function serializeCandidate(candidate) {
  const canonical = [candidate.left, candidate.right].sort((a, b) => a.key.localeCompare(b.key));
  const id = `DU-${sha1(canonical.map((unit) => unit.key).join('|')).slice(0, 8).toUpperCase()}`;
  return {
    id,
    score: round(candidate.score),
    relationship: candidate.relationship,
    family: candidate.left.family,
    left: serializeUnit(candidate.left),
    right: serializeUnit(candidate.right),
    metrics: candidate.metrics,
    divergence: candidate.divergence,
    reviewQuestions: reviewQuestions(candidate.left.family),
  };
}

function serializeUnit(unit) {
  return {
    name: unit.name,
    qualifiedName: unit.qualifiedName,
    kind: unit.kind,
    file: unit.file,
    package: unit.package,
    startLine: unit.startLine,
    endLine: unit.endLine,
    lineCount: unit.lineCount,
    tokenCount: unit.tokenCount,
    exported: unit.exported,
    useClient: unit.features.useClient,
  };
}

function reviewQuestions(family) {
  const shared = [
    'Do both abstractions enforce the same invariant, or only share syntax?',
    'Do their callers change for the same reasons and at the same cadence?',
    'Can the divergence be expressed as a stable variant without callback or boolean soup?',
    'Would the shared owner preserve package and dependency direction?',
  ];
  if (family === 'component') {
    return [
      ...shared,
      'Are state ownership, accessibility, focus behavior, and controlled/uncontrolled semantics equivalent?',
      'Do hook order, effects, Suspense/error boundaries, and client/server boundaries match?',
    ];
  }
  if (family === 'hook') {
    return [
      ...shared,
      'Are caching, cancellation, retries, invalidation, optimistic updates, and error semantics equivalent?',
      'Can the shared logic remain a valid hook with unconditional hook ordering?',
    ];
  }
  if (family === 'type' || family === 'schema') {
    return [
      ...shared,
      'Would unification preserve domain meaning rather than merely reduce repeated fields?',
      'Can invalid combinations be excluded with a discriminated union or separate wrappers?',
    ];
  }
  return shared;
}

function buildClusters(candidates) {
  const parent = new Map();
  const find = (value) => {
    if (!parent.has(value)) parent.set(value, value);
    const current = parent.get(value);
    if (current !== value) parent.set(value, find(current));
    return parent.get(value);
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const candidate of candidates) {
    if (candidate.score < 0.78) continue;
    const leftKey = unitPublicKey(candidate.left);
    const rightKey = unitPublicKey(candidate.right);
    union(leftKey, rightKey);
  }

  const groups = new Map();
  for (const candidate of candidates) {
    const keys = [unitPublicKey(candidate.left), unitPublicKey(candidate.right)];
    for (const key of keys) {
      if (!parent.has(key)) continue;
      const root = find(key);
      if (!groups.has(root)) groups.set(root, new Set());
      groups.get(root).add(key);
    }
  }

  const result = [];
  for (const members of groups.values()) {
    if (members.size < 3) continue;
    const memberList = [...members].sort();
    const related = candidates
      .filter((candidate) =>
        members.has(unitPublicKey(candidate.left)) && members.has(unitPublicKey(candidate.right)),
      )
      .map((candidate) => candidate.id);
    result.push({
      id: `DUC-${sha1(memberList.join('|')).slice(0, 8).toUpperCase()}`,
      members: memberList,
      candidateIds: related,
    });
  }
  return result.sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
}

function unitPublicKey(unit) {
  return `${unit.file}:${unit.startLine}:${unit.qualifiedName}`;
}

function writeOutputs(scan, options) {
  const json = `${JSON.stringify(scan, null, 2)}\n`;
  const markdown = renderMarkdown(scan);

  if (!options.json && !options.markdown) {
    process.stdout.write(markdown);
    return;
  }
  if (options.json) writeDestination(options.json, json);
  if (options.markdown) writeDestination(options.markdown, markdown);
}

function writeDestination(destination, content) {
  if (destination === '-') {
    process.stdout.write(content);
    return;
  }
  const resolved = path.resolve(destination);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content);
}

function renderMarkdown(scan) {
  const lines = [];
  lines.push('# TypeScript/React Dup Unifier Candidate Report', '');
  lines.push(`Generated: ${scan.generatedAt}`);
  lines.push(`Root: \`${escapeInline(scan.root)}\``);
  lines.push('');
  lines.push('## Scan summary', '');
  lines.push(`- Files scanned: ${scan.summary.filesScanned}`);
  lines.push(`- Abstractions analyzed: ${scan.summary.unitsAnalyzed}`);
  lines.push(`- Candidates found: ${scan.summary.candidatesFound}`);
  lines.push(`- Candidates emitted: ${scan.summary.candidatesEmitted}`);
  lines.push(`- Multi-member clusters: ${scan.summary.clusters}`);
  lines.push(`- Parse warnings: ${scan.summary.parseWarnings}`);
  lines.push('');
  lines.push('The score is a triage signal, not permission to merge. Confirm shared invariants, lifecycle semantics, ownership, and dependency direction in source before changing code.');
  lines.push('');

  if (scan.candidates.length === 0) {
    lines.push('No candidates met the configured threshold.', '');
  } else {
    lines.push('## Ranked candidates', '');
    lines.push('| ID | Score | Relationship | Left | Right |');
    lines.push('|---|---:|---|---|---|');
    for (const candidate of scan.candidates) {
      lines.push(
        `| ${candidate.id} | ${candidate.score.toFixed(3)} | ${candidate.relationship} | ` +
        `${unitLink(candidate.left)} | ${unitLink(candidate.right)} |`,
      );
    }
    lines.push('');

    for (const candidate of scan.candidates) {
      lines.push(`## ${candidate.id}: ${candidate.left.qualifiedName} ↔ ${candidate.right.qualifiedName}`, '');
      lines.push(`- Score: **${candidate.score.toFixed(3)}**`);
      lines.push(`- Relationship: **${candidate.relationship}**`);
      lines.push(`- Family: **${candidate.family}**`);
      lines.push(`- Left: ${unitLink(candidate.left)} (${candidate.left.lineCount} lines)`);
      lines.push(`- Right: ${unitLink(candidate.right)} (${candidate.right.lineCount} lines)`);
      lines.push('');
      lines.push('### Similarity signals', '');
      lines.push('| Shape | Behavior | Control flow | Semantic terms | Size |');
      lines.push('|---:|---:|---:|---:|---:|');
      lines.push(
        `| ${candidate.metrics.shape.toFixed(3)} | ${candidate.metrics.behavior.toFixed(3)} | ` +
        `${candidate.metrics.control.toFixed(3)} | ${candidate.metrics.semantic.toFixed(3)} | ` +
        `${candidate.metrics.size.toFixed(3)} |`,
      );
      lines.push('');
      lines.push('### Divergence to inspect', '');
      const divergenceLines = summarizeDivergence(candidate.divergence);
      if (divergenceLines.length) {
        lines.push(...divergenceLines.map((line) => `- ${line}`));
      } else {
        lines.push('- No material signal-level divergence detected; inspect naming, behavior, tests, and callers.');
      }
      lines.push('');
      lines.push('### Required review', '');
      lines.push(...candidate.reviewQuestions.map((question) => `- ${question}`));
      lines.push('');
      lines.push('### Decision record', '');
      lines.push('- Decision: `unify-now | shared-core | standardize-contract | intentional-duplicate | false-positive`');
      lines.push('- Canonical owner:');
      lines.push('- Stable variation seam:');
      lines.push('- Migration and validation:');
      lines.push('');
    }
  }

  if (scan.clusters.length) {
    lines.push('## Multi-member clusters', '');
    for (const cluster of scan.clusters) {
      lines.push(`### ${cluster.id}`);
      for (const member of cluster.members) lines.push(`- \`${escapeInline(member)}\``);
      lines.push('');
    }
  }

  if (scan.parseWarnings.length) {
    lines.push('## Parse warnings', '');
    for (const warning of scan.parseWarnings) {
      const location = warning.line ? `:${warning.line}:${warning.column ?? 1}` : '';
      lines.push(`- \`${escapeInline(warning.file)}${location}\`: ${warning.message}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function summarizeDivergence(divergence) {
  const lines = [];
  const labels = {
    calls: 'Calls',
    hooks: 'Hooks',
    jsxTags: 'JSX tags',
    jsxAttributes: 'JSX attributes',
    propKeys: 'Prop surface',
    memberKeys: 'Member keys',
    typeRefs: 'Type references',
    imports: 'Dependencies',
    literals: 'Literals/defaults',
  };

  for (const [key, label] of Object.entries(labels)) {
    const entry = divergence[key];
    if (!entry || (!entry.onlyLeft.length && !entry.onlyRight.length)) continue;
    const parts = [];
    if (entry.onlyLeft.length) parts.push(`left-only: ${entry.onlyLeft.map(code).join(', ')}`);
    if (entry.onlyRight.length) parts.push(`right-only: ${entry.onlyRight.map(code).join(', ')}`);
    lines.push(`${label} — ${parts.join('; ')}`);
  }
  const controlEntries = Object.entries(divergence.controlDelta ?? {});
  if (controlEntries.length) {
    lines.push(`Control-flow delta (left minus right): ${controlEntries.map(([key, value]) => `${key}=${signed(value)}`).join(', ')}`);
  }
  if (divergence.asyncMismatch) lines.push('Async behavior differs.');
  if (divergence.clientBoundaryMismatch) lines.push('React client/server boundary differs (`use client`).');
  if (Math.abs(divergence.lineDelta) >= 8) lines.push(`Line-count delta: ${signed(divergence.lineDelta)}.`);
  return lines;
}

function unitLink(unit) {
  return `\`${escapeInline(unit.qualifiedName)}\` at \`${escapeInline(unit.file)}:${unit.startLine}\``;
}

function code(value) {
  return `\`${escapeInline(String(value))}\``;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  for (const value of smaller) if (larger.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection || 1);
}

function containment(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  for (const value of smaller) if (larger.has(value)) intersection += 1;
  return intersection / Math.max(1, smaller.size);
}

function cosineMaps(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  for (const [key, value] of smaller) dot += value * (larger.get(key) ?? 0);
  if (leftNorm === 0 && rightNorm === 0) return 1;
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function sizeRatio(left, right) {
  return Math.min(left.tokenCount, right.tokenCount) / Math.max(1, Math.max(left.tokenCount, right.tokenCount));
}

function makeShingles(tokens, width) {
  const result = new Set();
  if (tokens.length === 0) return result;
  if (tokens.length < width) {
    result.add(hash32(tokens.join('|')));
    return result;
  }
  for (let index = 0; index <= tokens.length - width; index += 1) {
    result.add(hash32(tokens.slice(index, index + width).join('|')));
  }
  return result;
}

function hash32(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function splitIdentifier(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function calleeName(ts, expression, sourceFile) {
  if (!expression) return '';
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const left = calleeName(ts, expression.expression, sourceFile);
    return left ? `${left}.${expression.name.text}` : expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)) {
    const left = calleeName(ts, expression.expression, sourceFile);
    return left ? `${left}[]` : '[]';
  }
  if (ts.isCallExpression(expression)) {
    return calleeName(ts, expression.expression, sourceFile);
  }
  return expression.getText ? truncate(expression.getText(sourceFile), 80) : '';
}

function conciseCallee(name) {
  const parts = name.split('.');
  if (parts.length <= 2) return name;
  return parts.slice(-2).join('.');
}

function propertyNameText(ts, node, sourceFile) {
  if (!node) return '';
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return truncate(node.getText(sourceFile), 80);
}

function isExported(ts, node) {
  return hasModifier(ts, node, ts.SyntaxKind.ExportKeyword) ||
    Boolean(node.parent && hasModifier(ts, node.parent, ts.SyntaxKind.ExportKeyword));
}

function hasModifier(ts, node, kind) {
  return Boolean(ts.getModifiers?.(node)?.some((modifier) => modifier.kind === kind) ||
    node.modifiers?.some((modifier) => modifier.kind === kind));
}

function flattenDiagnostic(ts, message) {
  return ts.flattenDiagnosticMessageText(message, '\n');
}

function truncate(value, length) {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function toRelative(root, file) {
  const stat = fs.existsSync(root) ? fs.statSync(root) : null;
  if (stat?.isFile()) return path.basename(file);
  return path.relative(root, file) || path.basename(file);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function ensureTrailingSeparator(value) {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function escapeInline(value) {
  return String(value).replace(/`/g, '\\`').replace(/\|/g, '\\|');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`typescript-react-dup-unifier: ${message}`);
  process.exitCode = 1;
});
