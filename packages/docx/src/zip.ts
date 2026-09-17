/**
 * A minimal ZIP reader and writer, enough for the parts of a .docx we touch.
 *
 * Node has no built-in archive support, and pulling a library in for this would
 * be a poor trade: the format's central directory is a few fixed-width fields,
 * and `node:zlib` already does the compression. Writing it out also means the
 * editor's document builder has its half ready.
 *
 * Server-side only — it uses node:zlib.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

const STORED = 0;
const DEFLATED = 8;

export class ZipError extends Error {}

/**
 * The most a single entry may inflate to: 16 MiB, the API own per-part limit.
 *
 * The archives read here have already passed the API checks, but this reader
 * runs in the platform process and should not bet its memory on another
 * service having been right. A few kilobytes of deflated zeros can expand to
 * gigabytes; the ceiling turns that into an error instead of an outage.
 */
export const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/**
 * Reads one entry by name, or returns null when the archive does not hold it.
 *
 * The entry is located through the central directory rather than by scanning
 * for local headers: the central directory is the archive's own index, and
 * trusting it is what makes a lookup a seek instead of a search.
 */
export function readZipEntry(
  archive: Uint8Array,
  wanted: string,
): Uint8Array | null {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );

  let cursor = findCentralDirectory(archive, view);

  while (cursor + 46 <= archive.byteLength) {
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER) break;

    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    const name = new TextDecoder().decode(
      archive.subarray(cursor + 46, cursor + 46 + nameLength),
    );

    if (name === wanted) {
      return readLocalEntry(archive, view, localOffset, method, compressedSize);
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return null;
}

/**
 * Reads the data of one entry, starting from its local header.
 *
 * The local header's extra field can differ in length from the central
 * directory's, which is why the offsets are read again here rather than reused.
 */
function readLocalEntry(
  archive: Uint8Array,
  view: DataView,
  offset: number,
  method: number,
  compressedSize: number,
): Uint8Array {
  if (view.getUint32(offset, true) !== LOCAL_HEADER) {
    throw new ZipError("local header not found where the index said it was");
  }

  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const body = archive.subarray(start, start + compressedSize);

  switch (method) {
    case STORED:
      return body;
    case DEFLATED:
      try {
        return new Uint8Array(
          inflateRawSync(body, { maxOutputLength: MAX_ENTRY_BYTES }),
        );
      } catch (error) {
        // Node reports an output past maxOutputLength as a RangeError.
        if (error instanceof RangeError) {
          throw new ZipError(`entry inflates beyond ${MAX_ENTRY_BYTES} bytes`);
        }
        throw error;
      }
    default:
      throw new ZipError(`unsupported compression method ${method}`);
  }
}

/** Locates the central directory through the end-of-central-directory record. */
function findCentralDirectory(archive: Uint8Array, view: DataView): number {
  // The record sits at the very end, after a comment of up to 64 KiB, so the
  // only way to it is backwards from the last possible position.
  const earliest = Math.max(0, archive.byteLength - 22 - 0xffff);

  for (let at = archive.byteLength - 22; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) {
      return view.getUint32(at + 16, true);
    }
  }

  throw new ZipError("not a zip archive: no end-of-central-directory record");
}

/**
 * Writes a ZIP archive.
 *
 * Everything is deflated and no data descriptors are used, so sizes and CRCs
 * are known before each header is written — which keeps this a single pass.
 */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];

  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const compressed = new Uint8Array(deflateRawSync(entry.data));
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0x0800, true); // UTF-8 names
    localView.setUint16(8, DEFLATED, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.byteLength, true);
    localView.setUint32(22, entry.data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_HEADER, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, DEFLATED, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressed.byteLength, true);
    centralView.setUint32(24, entry.data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.byteLength + compressed.byteLength;
  }

  const directorySize = centrals.reduce((sum, c) => sum + c.byteLength, 0);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);

  return concat([...locals, ...centrals, end]);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);

  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The CRC-32 the format requires, with its table built once on first use. */
let crcTable: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
  crcTable ??= buildCrcTable();

  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
}
