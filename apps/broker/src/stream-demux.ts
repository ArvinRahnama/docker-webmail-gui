/**
 * Decodes Docker's container log/attach stream framing
 * (docs/research/02-docker-api-security.md §A.2) so the web tier never
 * touches raw Docker framing (ARCHITECTURE.md §6). Two formats:
 *
 * - **Non-TTY** (the DMS default): multiplexed. Each frame is an 8-byte
 *   header — `[STREAM_TYPE, 0, 0, 0, SIZE1..SIZE4]`, `SIZE` a big-endian
 *   uint32 — followed by that many payload bytes. `STREAM_TYPE` is `1`
 *   for stdout, `2` for stderr (`0`/stdin frames are documented as
 *   "written on stdout").
 * - **TTY**: raw, unframed bytes — Docker merges stdout/stderr once a PTY
 *   is involved, so there is nothing to demultiplex.
 *
 * {@link DockerStreamDemuxer} is the load-bearing piece: frames can be
 * split across chunk boundaries at an arbitrary byte offset — including
 * inside the 8-byte header itself — because this only ever sees whatever
 * chunk sizes the transport happened to deliver. It buffers a partial
 * frame across `push()` calls and only ever emits frames it could decode
 * completely.
 */

export type DockerStreamKind = 'stdout' | 'stderr';

export interface DemuxedFrame {
  readonly stream: DockerStreamKind;
  readonly data: Buffer;
}

const HEADER_LENGTH = 8;
const SIZE_OFFSET = 4;
const STREAM_TYPE_STDERR = 2;

function streamKindFromType(type: number): DockerStreamKind {
  // STDIN-copy frames (type 0) are documented as "written on stdout" —
  // there is no third bucket in this project's vocabulary for them.
  return type === STREAM_TYPE_STDERR ? 'stderr' : 'stdout';
}

/**
 * Incremental decoder for the non-TTY multiplexed format. Safe to feed
 * chunks of any size, including ones that split a frame's header or
 * payload — call {@link push} once per chunk as it arrives; it returns
 * only the frames that became fully available on that call.
 */
export class DockerStreamDemuxer {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DemuxedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: DemuxedFrame[] = [];

    for (;;) {
      if (this.buffer.length < HEADER_LENGTH) break;

      const size = this.buffer.readUInt32BE(SIZE_OFFSET);
      const frameEnd = HEADER_LENGTH + size;
      if (this.buffer.length < frameEnd) break; // payload not fully arrived yet

      const streamType = this.buffer.readUInt8(0);
      const data = Buffer.from(this.buffer.subarray(HEADER_LENGTH, frameEnd));
      frames.push({ stream: streamKindFromType(streamType), data });

      this.buffer = this.buffer.subarray(frameEnd);
    }

    return frames;
  }

  /** True if a partial frame remains buffered — the source ended mid-frame. Worth logging; not itself a reason to throw. */
  hasPendingPartialFrame(): boolean {
    return this.buffer.length > 0;
  }
}

/** Decodes a complete, already-fully-received non-TTY multiplexed buffer in one call — the common case for a bounded (non-follow) logs fetch. */
export function demuxNonTtyBuffer(buffer: Buffer): DemuxedFrame[] {
  return new DockerStreamDemuxer().push(buffer);
}

/**
 * TTY-allocated containers produce raw, unframed bytes — there is no
 * header to decode and Docker has already merged stdout/stderr into one
 * stream. Surfaced as a single `'stdout'` frame so callers get one
 * consistent frame shape regardless of which branch ran.
 */
export function decodeTtyBuffer(buffer: Buffer): DemuxedFrame[] {
  return buffer.length === 0 ? [] : [{ stream: 'stdout', data: buffer }];
}

/** Picks the TTY/non-TTY branch per `Config.Tty` from a prior inspect — the same fact Docker itself uses to decide `Content-Type` (§A.2). */
export function demuxDockerStream(
  buffer: Buffer,
  options: { readonly tty: boolean },
): DemuxedFrame[] {
  return options.tty ? decodeTtyBuffer(buffer) : demuxNonTtyBuffer(buffer);
}
