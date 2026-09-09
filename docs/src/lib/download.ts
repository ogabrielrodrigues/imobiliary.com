/**
 * Hands a file to the browser to save.
 *
 * The bytes arrive from a server function rather than from a link, because the
 * API is not reachable from the page — a plain `<a href>` to it would have
 * nothing to point at. The object URL is revoked on the next tick: revoking it
 * synchronously can cancel the download in some browsers before it starts.
 */
export function saveFile(
  filename: string,
  contentType: string,
  bytes: Uint8Array,
): void {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: contentType }),
  );

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}
