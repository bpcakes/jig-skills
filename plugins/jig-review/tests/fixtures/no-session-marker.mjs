// A developer may run this suite from a Claude Code shell, which sets
// CLAUDECODE. The option helpers and the controller's init print a note there
// when --host is omitted, so the commands these tests start would behave
// differently than they do in CI. Tests of that note set the marker themselves.
delete process.env.CLAUDECODE;
