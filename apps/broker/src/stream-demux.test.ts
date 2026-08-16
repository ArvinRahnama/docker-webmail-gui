import { describe, expect, it } from 'vitest';
import {
  decodeTtyBuffer,
  demuxDockerStream,
  demuxNonTtyBuffer,
  DockerStreamDemuxer,
} from './stream-demux.js';

const STDOUT = 1;
const STDERR = 2;
const STDIN = 0;
const HEADER_LENGTH_FOR_TEST = 8;

/** Builds one raw multiplexed frame exactly per docs/research/02-docker-api-security.md §A.2: `[STREAM_TYPE,0,0,0,SIZE1..4]` + payload. */
function buildFrame(streamType: number, payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

describe('demuxNonTtyBuffer — single complete buffer', () => {
  it('decodes a single stdout frame', () => {
    const frames = demuxNonTtyBuffer(buildFrame(STDOUT, 'hello world'));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.stream).toBe('stdout');
    expect(frames[0]?.data.toString('utf8')).toBe('hello world');
  });

  it('decodes a single stderr frame', () => {
    const frames = demuxNonTtyBuffer(buildFrame(STDERR, 'oh no'));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.stream).toBe('stderr');
    expect(frames[0]?.data.toString('utf8')).toBe('oh no');
  });

  it('routes a stdin-copy frame (type 0) to stdout, per the documented spec', () => {
    const frames = demuxNonTtyBuffer(buildFrame(STDIN, 'echoed input'));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.stream).toBe('stdout');
  });

  it('decodes multiple concatenated frames in order, correctly attributed', () => {
    const buffer = Buffer.concat([
      buildFrame(STDOUT, 'line one'),
      buildFrame(STDERR, 'line two'),
      buildFrame(STDOUT, 'line three'),
    ]);

    const frames = demuxNonTtyBuffer(buffer);

    expect(frames.map((f) => [f.stream, f.data.toString('utf8')])).toEqual([
      ['stdout', 'line one'],
      ['stderr', 'line two'],
      ['stdout', 'line three'],
    ]);
  });

  it('decodes a zero-length payload frame without consuming past its header', () => {
    const buffer = Buffer.concat([buildFrame(STDOUT, ''), buildFrame(STDOUT, 'next')]);
    const frames = demuxNonTtyBuffer(buffer);
    expect(frames).toEqual([
      { stream: 'stdout', data: Buffer.from('') },
      { stream: 'stdout', data: Buffer.from('next') },
    ]);
  });

  it('returns an empty array for an empty buffer', () => {
    expect(demuxNonTtyBuffer(Buffer.alloc(0))).toEqual([]);
  });
});

describe('DockerStreamDemuxer — frames split across chunk boundaries', () => {
  it('decodes a frame whose payload is split across two push() calls', () => {
    const full = buildFrame(STDOUT, 'a payload split mid-way through');
    const splitAt = HEADER_LENGTH_FOR_TEST + 5; // header intact, payload cut early

    const demuxer = new DockerStreamDemuxer();
    const firstResult = demuxer.push(full.subarray(0, splitAt));
    expect(firstResult).toEqual([]);
    expect(demuxer.hasPendingPartialFrame()).toBe(true);

    const secondResult = demuxer.push(full.subarray(splitAt));
    expect(secondResult).toHaveLength(1);
    expect(secondResult[0]?.data.toString('utf8')).toBe('a payload split mid-way through');
    expect(demuxer.hasPendingPartialFrame()).toBe(false);
  });

  it('decodes a frame whose 8-byte header itself is split across two push() calls', () => {
    const full = buildFrame(STDERR, 'header was cut in half');

    const demuxer = new DockerStreamDemuxer();
    const firstResult = demuxer.push(full.subarray(0, 3)); // 3 of 8 header bytes
    expect(firstResult).toEqual([]);
    expect(demuxer.hasPendingPartialFrame()).toBe(true);

    const secondResult = demuxer.push(full.subarray(3));
    expect(secondResult).toHaveLength(1);
    expect(secondResult[0]?.stream).toBe('stderr');
    expect(secondResult[0]?.data.toString('utf8')).toBe('header was cut in half');
  });

  it('decodes a frame split across three push() calls (one byte at a time through the header)', () => {
    const full = buildFrame(STDOUT, 'byte at a time');
    const demuxer = new DockerStreamDemuxer();

    let lastResult: ReturnType<DockerStreamDemuxer['push']> = [];
    for (let i = 0; i < full.length; i += 1) {
      lastResult = demuxer.push(full.subarray(i, i + 1));
    }

    expect(lastResult).toHaveLength(1);
    expect(lastResult[0]?.data.toString('utf8')).toBe('byte at a time');
  });

  it('emits only the complete frames when a chunk contains one full frame plus a partial second one', () => {
    const complete = buildFrame(STDOUT, 'complete frame');
    const partialNext = buildFrame(STDERR, 'this one gets cut off').subarray(0, 6);

    const demuxer = new DockerStreamDemuxer();
    const result = demuxer.push(Buffer.concat([complete, partialNext]));

    expect(result).toHaveLength(1);
    expect(result[0]?.data.toString('utf8')).toBe('complete frame');
    expect(demuxer.hasPendingPartialFrame()).toBe(true);
  });

  it('has no pending partial frame once every chunk has been fully consumed', () => {
    const demuxer = new DockerStreamDemuxer();
    demuxer.push(buildFrame(STDOUT, 'whole thing at once'));
    expect(demuxer.hasPendingPartialFrame()).toBe(false);
  });
});

describe('decodeTtyBuffer', () => {
  it('returns the raw bytes as a single stdout frame, unparsed', () => {
    const raw = Buffer.from('raw pty output, no header at all');
    const frames = decodeTtyBuffer(raw);
    expect(frames).toEqual([{ stream: 'stdout', data: raw }]);
  });

  it('does not attempt to interpret the first 8 bytes as a header', () => {
    // These bytes would decode (incorrectly) as a huge/garbage frame size
    // under the non-TTY path; the TTY path must never even look.
    const raw = Buffer.from([255, 255, 255, 255, 255, 255, 255, 255, 1, 2, 3]);
    const frames = decodeTtyBuffer(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toEqual(raw);
  });

  it('returns an empty array for an empty buffer', () => {
    expect(decodeTtyBuffer(Buffer.alloc(0))).toEqual([]);
  });
});

describe('demuxDockerStream — branches on tty', () => {
  it('uses the non-TTY multiplexed decoder when tty is false', () => {
    const frames = demuxDockerStream(buildFrame(STDERR, 'x'), { tty: false });
    expect(frames).toEqual([{ stream: 'stderr', data: Buffer.from('x') }]);
  });

  it('uses the raw TTY decoder when tty is true, even for bytes that look like a header', () => {
    const raw = buildFrame(STDERR, 'x'); // would decode as a stderr frame under non-TTY
    const frames = demuxDockerStream(raw, { tty: true });
    expect(frames).toEqual([{ stream: 'stdout', data: raw }]);
  });
});
