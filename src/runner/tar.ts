import { MILLISECONDS_PER_SECOND, TAR } from "../shared/constants.js";

/** One entry of a tar archive, as much of its header as Autoheal reads or writes. */
export interface TarHeader {
  name: string;
  type: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  linkName: string;
}

const ZEROS = Buffer.alloc(TAR.blockBytes);
const isAscii = (text: string) => [...text].every((character) => character.charCodeAt(0) < TAR.asciiLimit);
const padding = (size: number) => (TAR.blockBytes - (size % TAR.blockBytes)) % TAR.blockBytes;

function writeOctal(block: Buffer, field: { offset: number; length: number }, value: number) {
  block.write(value.toString(TAR.octal).padStart(field.length - 1, "0"), field.offset, "ascii");
}

function headerBlock(name: string, type: string, mode: number, uid: number, gid: number, size: number): Buffer {
  const block = Buffer.alloc(TAR.blockBytes);
  block.write(name, TAR.fields.name.offset, TAR.fields.name.length, "utf8");
  writeOctal(block, TAR.fields.mode, mode);
  writeOctal(block, TAR.fields.uid, uid);
  writeOctal(block, TAR.fields.gid, gid);
  writeOctal(block, TAR.fields.size, size);
  writeOctal(block, TAR.fields.modified, Math.floor(Date.now() / MILLISECONDS_PER_SECOND));
  block.write(type, TAR.fields.type.offset, "ascii");
  block.write(TAR.magic, TAR.fields.magic.offset, "ascii");
  // The checksum counts its own field as spaces.
  block.fill(TAR.space, TAR.fields.checksum.offset, TAR.fields.checksum.offset + TAR.fields.checksum.length);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(TAR.octal).padStart(TAR.checksumDigits, "0")}\0 `, TAR.fields.checksum.offset);
  return block;
}

// A name that does not fit a plain header goes in a PAX record before it: "<length> path=<name>\n".
function paxPath(name: string): Buffer {
  const body = ` ${TAR.paxPathKey}=${name}\n`;
  let length = Buffer.byteLength(body);
  length += String(length + String(length).length).length;
  const record = Buffer.from(`${length}${body}`);
  return Buffer.concat([
    headerBlock(TAR.paxName, TAR.types.pax, TAR.paxMode, 0, 0, record.length),
    record,
    ZEROS.subarray(0, padding(record.length)),
  ]);
}

/** An archive of one file or one folder, ready for Docker to unpack into a folder. */
export function singleEntryArchive(entry: Omit<TarHeader, "size" | "linkName">, content: Buffer): Buffer {
  const fits = isAscii(entry.name) && Buffer.byteLength(entry.name) < TAR.fields.name.length;
  const extended = fits ? Buffer.alloc(0) : paxPath(entry.name);
  const header = headerBlock(fits ? entry.name : "", entry.type, entry.mode, entry.uid, entry.gid, content.length);
  return Buffer.concat([extended, header, content, ZEROS.subarray(0, padding(content.length)), ZEROS, ZEROS]);
}

function readOctal(block: Buffer, field: { offset: number; length: number }): number {
  const text = block.toString("ascii", field.offset, field.offset + field.length).replace(/[\0 ]+$/u, "");
  return text === "" ? 0 : parseInt(text, TAR.octal);
}

function readText(block: Buffer, field: { offset: number; length: number }): string {
  const bytes = block.subarray(field.offset, field.offset + field.length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}

function fullName(block: Buffer): string {
  const prefix = readText(block, TAR.fields.prefix);
  const name = readText(block, TAR.fields.name);
  return prefix === "" ? name : `${prefix}/${name}`;
}

export const parseHeader = (block: Buffer): TarHeader => ({
  name: fullName(block),
  type: readText(block, TAR.fields.type) || TAR.types.file,
  mode: readOctal(block, TAR.fields.mode),
  uid: readOctal(block, TAR.fields.uid),
  gid: readOctal(block, TAR.fields.gid),
  size: readOctal(block, TAR.fields.size),
  linkName: readText(block, TAR.fields.linkName),
});

/** When an entry last changed, in seconds since 1970, as the archive holds it. */
export const modifiedOf = (block: Buffer) => readOctal(block, TAR.fields.modified);

/**
 * Reads an archive as it streams in, to its first real entry: its header, and its content when it is a file
 * no bigger than the limit (null otherwise). Extended headers before it are passed over.
 */
export async function readFirstEntry(
  stream: AsyncIterable<Buffer>,
  limitBytes: number,
): Promise<{ header: TarHeader; content: Buffer | null } | null> {
  let buffered = Buffer.alloc(0);
  let header: TarHeader | null = null;
  for await (const chunk of stream) {
    buffered = Buffer.concat([buffered, chunk]);
    while (header === null && buffered.length >= TAR.blockBytes) {
      const block = buffered.subarray(0, TAR.blockBytes);
      if (block.equals(ZEROS)) {
        return null;
      }
      const parsed = parseHeader(block);
      const skipped = TAR.blockBytes + parsed.size + padding(parsed.size);
      if (!TAR.extendedTypes.has(parsed.type)) {
        header = parsed;
        buffered = buffered.subarray(TAR.blockBytes);
        break;
      }
      if (buffered.length < skipped) {
        break;
      }
      buffered = buffered.subarray(skipped);
    }
    if (header === null) {
      continue;
    }
    const wanted = header.type === TAR.types.file && header.size <= limitBytes;
    if (!wanted) {
      return { header, content: null };
    }
    if (buffered.length >= header.size) {
      return { header, content: Buffer.from(buffered.subarray(0, header.size)) };
    }
  }
  return header === null ? null : { header, content: null };
}
