const REVIEW_IGNORE_PATH = ".reviewignore";
const UNSUPPORTED_PATTERN = /[*?[\]\\]/;

function pathError(source, message) {
  return new Error(`${source}: ${message}`);
}

function normalizeExcludePath(value, source = "--exclude-path") {
  let normalized = String(value).trim();
  if (!normalized) throw pathError(source, "path must not be blank");
  if (normalized.includes("\0") || normalized.includes("\n") || normalized.includes("\r")) {
    throw pathError(source, "path must be a single text line");
  }
  if (normalized.startsWith("!")) {
    throw pathError(source, "negated patterns are not supported");
  }
  if (UNSUPPORTED_PATTERN.test(normalized)) {
    throw pathError(source, "glob patterns and backslashes are not supported; name a repository-relative path");
  }
  normalized = normalized.replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw pathError(source, "path must be a normalized repository-relative path");
  }
  if (normalized === REVIEW_IGNORE_PATH) {
    throw pathError(source, `${REVIEW_IGNORE_PATH} cannot exclude itself`);
  }
  return normalized;
}

function normalizeExcludePaths(values = [], source = "--exclude-path") {
  return [...new Set(values.map((value, index) => (
    normalizeExcludePath(value, values.length > 1 ? `${source} #${index + 1}` : source)
  )))].sort();
}

function parseReviewIgnore(text, source = REVIEW_IGNORE_PATH) {
  const paths = [];
  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    paths.push(normalizeExcludePath(line, `${source}:${index + 1}`));
  }
  return normalizeExcludePaths(paths, source);
}

async function resolveReviewExclusions({
  revision = null,
  explicitPaths = [],
  readFileAtRevision,
}) {
  const explicit = normalizeExcludePaths(explicitPaths);
  const contents = revision && readFileAtRevision
    ? await readFileAtRevision(revision, REVIEW_IGNORE_PATH)
    : null;
  const policy = contents == null
    ? []
    : parseReviewIgnore(contents, `${revision}:${REVIEW_IGNORE_PATH}`);
  return {
    excludePaths: [...new Set([...policy, ...explicit])].sort(),
    explicitExcludePaths: explicit,
    reviewIgnorePaths: policy,
    reviewIgnoreRevision: contents == null ? null : revision,
  };
}

function gitPathspec(excludePaths = []) {
  return [
    "--",
    ".",
    ...excludePaths.map((filePath) => `:(top,literal,exclude)${filePath}`),
  ];
}

function isExcludedPath(filePath, excludePaths = []) {
  return excludePaths.some((excluded) => (
    filePath === excluded || filePath.startsWith(`${excluded}/`)
  ));
}

function exclusionsForSubtree(excludePaths, subtreePath) {
  if (isExcludedPath(subtreePath, excludePaths)) {
    return { excluded: true, excludePaths: [] };
  }
  const prefix = `${subtreePath}/`;
  return {
    excluded: false,
    excludePaths: excludePaths
      .filter((filePath) => filePath.startsWith(prefix))
      .map((filePath) => filePath.slice(prefix.length)),
  };
}

export {
  REVIEW_IGNORE_PATH,
  exclusionsForSubtree,
  gitPathspec,
  isExcludedPath,
  normalizeExcludePath,
  normalizeExcludePaths,
  parseReviewIgnore,
  resolveReviewExclusions,
};
