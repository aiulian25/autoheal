import { Transform } from "node:stream";
import { APPLICATION_ARTIFACT, APPLICATION_ARTIFACT_ERRORS, APPLICATION_BACKUPS } from "./application-backups.js";
import { TAR } from "./constants.js";

// The header block and the start of the payload: all the checks need, before anything is passed on.
const CHECKED_PREFIX_BYTES = TAR.blockBytes + APPLICATION_ARTIFACT.minimumPayloadBytes;
const END_OF_ARCHIVE_BYTES = TAR.endBlocks * TAR.blockBytes;
// A plain file is type "0", or NUL in archives from before POSIX.
const REGULAR_FILE_TYPES = ["\0", TAR.types.file].map((type) => type.charCodeAt(0));
const fieldOf = (block: Buffer, { offset, length }: { offset: number; length: number }) =>
  block.subarray(offset, offset + length);
const octalOf = (field: Buffer) => Number.parseInt(field.toString().replace(/[\0 ]+$/u, ""), TAR.octal);
/** Accept only Docker's single fixed-name ciphertext entry, never arbitrary archive paths or plaintext. */
export function applicationArtifactStream() {
  let offset = 0,
    prefix = Buffer.alloc(0),
    size: number | null = null;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        if (offset + chunk.length > APPLICATION_BACKUPS.payloadBytes)
          throw new Error(APPLICATION_ARTIFACT_ERRORS.overQuota);
        const previouslyValidated = size !== null;
        const needed = previouslyValidated ? 0 : Math.min(CHECKED_PREFIX_BYTES - prefix.length, chunk.length);
        if (!previouslyValidated) {
          prefix = Buffer.concat([prefix, chunk.subarray(0, needed)]);
          if (prefix.length < CHECKED_PREFIX_BYTES) {
            offset += chunk.length;
            done();
            return;
          }
          const name = fieldOf(prefix, TAR.fields.name).toString().replace(/\0.*$/su, "");
          size = octalOf(fieldOf(prefix, TAR.fields.size));
          const kind = prefix[TAR.fields.type.offset];
          const header = prefix.subarray(0, TAR.blockBytes);
          const expectedChecksum = octalOf(fieldOf(header, TAR.fields.checksum));
          // The checksum counts its own field as spaces.
          const checksumField = TAR.fields.checksum;
          let checksum = 0;
          for (let i = 0; i < TAR.blockBytes; i++) {
            const inChecksumField = i >= checksumField.offset && i < checksumField.offset + checksumField.length;
            checksum += inChecksumField ? TAR.space : header[i]!;
          }
          const nonemptyPrefix = fieldOf(header, TAR.fields.prefix).some((byte) => byte !== 0);
          const regularFile = kind !== undefined && REGULAR_FILE_TYPES.includes(kind);
          const payloadStart = fieldOf(prefix, {
            offset: TAR.blockBytes,
            length: APPLICATION_ARTIFACT.ageHeader.length,
          });

          if (
            name !== APPLICATION_ARTIFACT.entryName ||
            nonemptyPrefix ||
            checksum !== expectedChecksum ||
            !regularFile ||
            !Number.isSafeInteger(size) ||
            size < APPLICATION_ARTIFACT.minimumPayloadBytes ||
            size > APPLICATION_BACKUPS.payloadBytes - TAR.blockBytes - END_OF_ARCHIVE_BYTES ||
            payloadStart.toString() !== APPLICATION_ARTIFACT.ageHeader
          )
            throw new Error(APPLICATION_ARTIFACT_ERRORS.notSinglePayload);
        }
        const checkPadding = (part: Buffer, start: number) => {
          const contentEnd = TAR.blockBytes + size!;
          if (
            start + part.length > contentEnd &&
            part.subarray(Math.max(0, contentEnd - start)).some((byte) => byte !== 0)
          )
            throw new Error(APPLICATION_ARTIFACT_ERRORS.extraEntries);
        };
        if (previouslyValidated) {
          checkPadding(chunk, offset);
          offset += chunk.length;
          done(null, chunk);
        } else {
          const remainder = chunk.subarray(needed);
          checkPadding(prefix, 0);
          checkPadding(remainder, CHECKED_PREFIX_BYTES);
          offset += chunk.length;
          // Docker must never see even a partial TAR header before the complete fixed-name header
          // and encrypted payload prefix have passed validation.
          this.push(prefix);
          prefix = Buffer.alloc(0);
          if (remainder.length) this.push(remainder);
          done();
        }
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done) {
      if (
        size === null ||
        offset < TAR.blockBytes + Math.ceil(size / TAR.blockBytes) * TAR.blockBytes + END_OF_ARCHIVE_BYTES
      )
        done(new Error(APPLICATION_ARTIFACT_ERRORS.incomplete));
      else done();
    },
  });
}
