const MAX_FILE_PATCH_BYTES = 2 * 1024 * 1024;
const HEADERS = ["diff --git ", "diff --cc ", "diff --combined "].map((text) => Buffer.from(text));
const PREFIX_BYTES = Math.max(...HEADERS.map((header) => header.length));

// Frame Git's patch stream without buffering entire lines: generated files may
// contain a single line larger than the evidence budget. Diff content lines
// carry a context/addition/deletion prefix, so they cannot impersonate headers.
function captureDiff({ checkTime, accept, omit }) {
  let prefix = Buffer.alloc(0);
  let lineStart = true;
  let chunks = [];
  let bytes = 0;
  let header = Buffer.alloc(0);
  let readingHeader = true;

  const append = (chunk) => {
    if (readingHeader) {
      const newline = chunk.indexOf(10);
      const end = newline < 0 ? chunk.length : newline;
      header = Buffer.concat([header, chunk.subarray(0, Math.min(end, 4096 - header.length))]);
      readingHeader = newline < 0 && header.length < 4096;
    }
    bytes += chunk.length;
    if (bytes > MAX_FILE_PATCH_BYTES) chunks = null;
    else chunks.push(Buffer.from(chunk));
  };

  const finishPatch = () => {
    if (!bytes) return;
    const label = JSON.stringify(header.toString("utf8"));
    if (chunks) accept(Buffer.concat(chunks, bytes), label);
    else omit(`${label}: file patch omitted (${bytes} bytes exceeds ${MAX_FILE_PATCH_BYTES}-byte limit)`);
    chunks = [];
    bytes = 0;
    header = Buffer.alloc(0);
    readingHeader = true;
  };

  const flushPrefix = () => {
    if (HEADERS.some((header) => prefix.subarray(0, header.length).equals(header))) finishPatch();
    append(prefix);
    prefix = Buffer.alloc(0);
    lineStart = false;
  };

  return {
    write(chunk) {
      checkTime();
      for (let offset = 0; offset < chunk.length;) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline + 1;
        if (lineStart) {
          const count = Math.min(PREFIX_BYTES - prefix.length, end - offset);
          prefix = Buffer.concat([prefix, chunk.subarray(offset, offset + count)]);
          offset += count;
          if (prefix.length === PREFIX_BYTES || (newline >= 0 && offset === end)) flushPrefix();
        } else {
          append(chunk.subarray(offset, end));
          offset = end;
        }
        if (newline >= 0 && offset === end) lineStart = true;
      }
    },
    end() {
      checkTime();
      if (prefix.length) flushPrefix();
      finishPatch();
    },
  };
}

export { captureDiff };
