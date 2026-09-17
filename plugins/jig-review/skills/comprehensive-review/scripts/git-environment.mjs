// A cwd-selected repository must not be redirected by a caller's Git hook,
// alternate index, object database, or command-line config environment.
export function gitEnvironment(inherited = process.env) {
  return { ...Object.fromEntries(Object.entries(inherited).filter(([name]) =>
    !/^(GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|GRAFT_FILE|SHALLOW_FILE|PREFIX|IMPLICIT_WORK_TREE|NAMESPACE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS)|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(name))),
  GIT_OPTIONAL_LOCKS: "0" };
}
