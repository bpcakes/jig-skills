const MAX_GITLINK_BYTES = 256 * 1024;
const GITLINK_PREFIX = Buffer.from("160000 ");

// Consume NUL-delimited index records without retaining ordinary tracked files.
// Bound both the unfinished record and the selected records, independently of
// the size of the repository's index. Keep paths as bytes until the caller decodes.
function createGitlinkCapture(maxBytes = MAX_GITLINK_BYTES) {
  let pending = Buffer.alloc(0);
  let retainedBytes = 0;
  const records = [];

  const checkLimit = (bytes) => {
    if (bytes > maxBytes) {
      throw Object.assign(new Error("gitlink capture exceeded its byte limit"), {
        outputLimit: true,
      });
    }
  };

  return {
    write(chunk) {
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      for (let end = data.indexOf(0); end !== -1; end = data.indexOf(0, start)) {
        checkLimit(end - start + 1);
        if (data.subarray(start, start + GITLINK_PREFIX.length).equals(GITLINK_PREFIX)) {
          retainedBytes += end - start + 1;
          checkLimit(retainedBytes);
          records.push(Buffer.from(data.subarray(start, end + 1)));
        }
        start = end + 1;
      }
      checkLimit(data.length - start);
      pending = Buffer.from(data.subarray(start));
    },
    finish() {
      if (pending.length) {
        throw Object.assign(
          new Error("gitlink capture ended with an unterminated index record"),
          { outputIncomplete: true },
        );
      }
      return Buffer.concat(records, retainedBytes);
    },
  };
}

export { createGitlinkCapture };
