# Recording

## Scope
Two capture modes that produce stereo WAV downloads at the context sample rate:
- **Live recording:** an AudioWorklet sink on the safety-limiter output captures everything audible, including live input.
- **Offline render:** the loaded MIDI song is rendered through the same engine in an `OfflineAudioContext`.

Both share one encoder (`wav.js`) and one download helper (`download.js`). The output chain is in `audio-safety.md`; worklet loading in `audioworklet.md`.

| Item | Live recording | Offline render |
|---|---|---|
| Source | Everything reaching the limiter: file playback, Web MIDI, computer keyboard | Loaded MIDI file only |
| Signal point | Safety-limiter output | Same chain, built in the offline context |
| Live input and arming | Captured | Excluded; arming ignored |
| Mute, solo, part assignment | As heard | Current rack state |
| Speed | Real time | Faster than real time |
| Maximum length | 10 min (project limit) | Song ≤ 10 min (project limit) plus 3 s tail (project limit) |
| Sample rate | `ctx.sampleRate` | Live context's `sampleRate`, or 48000 if none exists (project limit) |

`MediaRecorder` is not used: its output is lossy, its container and codec differ by browser, and it cannot capture an `OfflineAudioContext`.

Recordings are never written to `localStorage`, IndexedDB or a server. The Blob download is the only output, as with patch save (`patch-format.md`).

## Files
| Path | Contents |
|---|---|
| `public/worklets/recorder.js` | Recorder processor (plain JS) |
| `src/audio/recording/recorder.js` | `LiveRecorder`: node wiring, buffer pool, chunk store |
| `src/audio/recording/wav.js` | Header writer, body encoder, TPDF dither |
| `src/audio/recording/offline-render.js` | `renderSongToWav()` |
| `src/audio/recording/download.js` | `downloadBlob()`, `wavFilename()` |

## Live recording

### Graph placement
```
… → masterGain → safetyLimiter ─┬─→ destination
                                ├─→ meter (AnalyserNode)
                                └─→ recorderNode ──(silent output)──→ destination
```
- Node options: `numberOfInputs: 1`, `numberOfOutputs: 1`, `outputChannelCount: [2]`, `channelCount: 2`, `channelCountMode: 'explicit'`, `channelInterpretation: 'speakers'` (mono input up-mixes to L = R).
- The processor never writes to `outputs`. Outputs are zero-filled by default, so the connection to `destination` adds silence and leaves the audible signal unchanged.
- The output connection to `destination` places the node in the rendered graph in every engine. Processing of worklet nodes with no path to `destination` is not specified normatively, so the design does not rely on it.
- The recorder is a parallel sink, never in series between the limiter and `destination`.
- When nothing feeds the input in a render quantum, `inputs[0]` is an empty array; the processor records zeros for that quantum so the timeline stays continuous.
- `process()` returns `true` for the node's lifetime.

### Buffer transport
Transferring an `ArrayBuffer` detaches it on the sending side, so the worklet cannot reuse a buffer it has posted. Buffers circulate through a pool:

1. The main thread allocates 12 (project limit) `Float32Array(2 × 8192)` buffers and transfers them to the processor. Layout is planar: L in `[0, 8192)`, R in `[8192, 16384)`; 65,536 bytes each.
2. The processor keeps received buffers in a fixed-capacity stack (capacity 32, project limit). `process()` only pops, writes samples and posts; it constructs no typed arrays or objects.
3. A full chunk is posted with `[chunk.buffer]` as the transfer list. The message object and transfer-list array are reused.
4. The main thread stores the chunk and transfers one newly allocated replacement back. All allocation happens on the main thread.
5. If the stack is empty when a chunk is needed (main thread stalled longer than ≈ 2.05 s at 48 kHz), the processor counts the frames as dropped and keeps advancing the capture timeline. The next chunk's `offset` exposes the gap, which is encoded as zeros.

`postMessage` allocates internally; at 8192 frames it runs ≈ 5.9 times per second at 48 kHz, not per render quantum. Structured cloning runs synchronously inside `postMessage`, so reusing the message object is safe. A `SharedArrayBuffer` ring buffer would avoid `postMessage` but requires cross-origin isolation (COOP/COEP headers) and is not used.

### Processor (`public/worklets/recorder.js`)
```js
// Messages in:  {type:'buffers', list} | {type:'start', atFrame, maxFrames} | {type:'stop', atFrame}
// Messages out: {type:'started', frame} | {type:'chunk', data, offset, frames, peak, clipped}
//               {type:'done', captured, requested, dropped, discontinuities, reason}
const IDLE = 0, ARMED = 1, RECORDING = 2, DONE = 3;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.chunkFrames = o.chunkFrames || 8192;
    this.pool = new Array(o.poolCapacity || 32);
    this.poolSize = 0;
    this.cur = null;
    this.fill = 0;
    this.chunkOffset = 0;
    this.state = IDLE;
    this.startFrame = 0;
    this.stopFrame = Number.MAX_SAFE_INTEGER;
    this.maxFrames = 0;
    this.captured = 0;
    this.dropped = 0;
    this.peak = 0;
    this.clipped = false;
    this.lastBlockEnd = -1;
    this.discontinuities = 0;
    this.chunkMsg = { type: 'chunk', data: null, offset: 0, frames: 0, peak: 0, clipped: false };
    this.transfer = [null];
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (m.type === 'buffers') {
      for (let i = 0; i < m.list.length && this.poolSize < this.pool.length; i++) {
        this.pool[this.poolSize++] = m.list[i];
      }
    } else if (m.type === 'start' && this.state === IDLE) {
      this.startFrame = m.atFrame;
      this.maxFrames = m.maxFrames;
      this.state = ARMED;
    } else if (m.type === 'stop' && (this.state === ARMED || this.state === RECORDING)) {
      this.stopFrame = m.atFrame;
    }
  }

  acquire() {
    if (this.poolSize === 0) return false;
    this.cur = this.pool[--this.poolSize];
    this.pool[this.poolSize] = null;
    this.fill = 0;
    this.chunkOffset = this.captured;
    return true;
  }

  flush() {
    const msg = this.chunkMsg;
    msg.data = this.cur;
    msg.offset = this.chunkOffset;
    msg.frames = this.fill;
    msg.peak = this.peak;
    msg.clipped = this.clipped;
    this.transfer[0] = this.cur.buffer;
    this.port.postMessage(msg, this.transfer);
    msg.data = null;
    this.transfer[0] = null;
    this.cur = null;
    this.fill = 0;
    this.peak = 0;
    this.clipped = false;
  }

  finish(reason) {
    if (this.cur !== null && this.fill > 0) this.flush();
    this.state = DONE;
    this.port.postMessage({
      type: 'done', captured: this.captured, dropped: this.dropped,
      requested: this.stopFrame - this.startFrame,
      discontinuities: this.discontinuities, reason,
    });
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const n = out.length > 0 ? out[0].length : 128;   // block length; not hard-coded
    const blockStart = currentFrame;
    const blockEnd = blockStart + n;

    if (this.lastBlockEnd >= 0 && blockStart !== this.lastBlockEnd) this.discontinuities++;
    this.lastBlockEnd = blockEnd;

    if (this.state === ARMED && blockEnd > this.startFrame) {
      if (this.startFrame < blockStart) this.startFrame = blockStart;   // start message arrived late
      this.state = RECORDING;
      this.port.postMessage({ type: 'started', frame: this.startFrame });
    }
    if (this.state !== RECORDING) return true;

    const input = inputs[0];
    const L = input.length > 0 ? input[0] : null;
    const R = input.length > 1 ? input[1] : L;
    const i0 = this.startFrame > blockStart ? this.startFrame - blockStart : 0;
    let i1 = this.stopFrame < blockEnd ? Math.max(i0, this.stopFrame - blockStart) : n;
    const remaining = this.maxFrames - this.captured;
    if (i1 - i0 > remaining) i1 = i0 + remaining;

    const cf = this.chunkFrames;
    for (let i = i0; i < i1; i++) {
      if (this.cur === null && !this.acquire()) {
        this.dropped += i1 - i;
        this.captured += i1 - i;
        break;
      }
      const l = L !== null ? L[i] : 0;
      const r = R !== null ? R[i] : 0;
      const buf = this.cur;
      buf[this.fill] = l;
      buf[cf + this.fill] = r;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      const a = al > ar ? al : ar;
      if (a > this.peak) this.peak = a;
      if (a >= 1) this.clipped = true;
      this.fill++;
      this.captured++;
      if (this.fill === cf) this.flush();
    }

    if (this.captured >= this.maxFrames) this.finish('max-length');
    else if (blockEnd >= this.stopFrame) this.finish('stopped');
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
```
`started` and `done` are posted once per take.

### Start and stop
- Start: the main thread sends `atFrame = Math.round(atTime * sampleRate)`.
  - "Record from song start": `atTime` is the scheduler's song start time, which is in the future because of the lookahead (`midi-playback-scheduling.md`); capture begins on that frame.
  - Immediate start: `atTime = ctx.currentTime`. If the message arrives after that frame, capture starts at the first processed quantum and `started` reports the actual frame.
- Stop: `atFrame = Math.round(ctx.currentTime * sampleRate)` at the click. Frames captured past it because of message latency are trimmed: `finalFrames = min(captured, requested)`.
- `currentFrame` advances by the block length after each block. The processor reads the block length from `outputs[0][0].length` because the render quantum size is configurable in Web Audio 1.1 (`renderSizeHint`).

### Dropouts
- Output-device underruns are not visible to the worklet: the render clock stays continuous, so the file contains continuous audio even if playback glitched.
- `discontinuities` counts blocks whose `currentFrame` does not follow the previous block's end. It is diagnostic only.
- Pool exhaustion is reported as `dropped > 0` and produces zero-filled gaps.

### Main thread (`src/audio/recording/recorder.js`)
```ts
export const RECORD_MAX_SECONDS = 600;   // (project limit)
export const CHUNK_FRAMES = 8192;        // (project limit)
export const POOL_INITIAL = 12;          // (project limit)
export const DONE_TIMEOUT_MS = 500;      // (project limit)

export type RecordStopReason = 'stopped' | 'max-length' | 'interrupted' | 'error';

interface Chunk { offset: number; frames: number; data: Float32Array; }

export interface Take {
  sampleRate: number;
  frames: number;
  chunks: Chunk[];
  chunkFrames: number;
  dropped: number;
  reason: RecordStopReason;
}

export class LiveRecorder {
  private node: AudioWorkletNode;
  private chunks: Chunk[] = [];
  private startFrame = 0;
  private finish: ((t: Take) => void) | null = null;
  private lastPeak = 0;
  private clipped = false;

  /** The 'recorder' module is loaded with the other worklets (audioworklet.md). */
  constructor(private ctx: AudioContext, limiterOut: AudioNode) {
    this.node = new AudioWorkletNode(ctx, 'recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { chunkFrames: CHUNK_FRAMES, poolCapacity: 32 },
    });
    limiterOut.connect(this.node);
    this.node.connect(ctx.destination);   // silent output
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    this.sendBuffers(POOL_INITIAL);
  }

  get peak(): number { return this.lastPeak; }
  get hasClipped(): boolean { return this.clipped; }
  get startedAtFrame(): number { return this.startFrame; }

  private sendBuffers(count: number): void {
    const list: Float32Array[] = [];
    for (let i = 0; i < count; i++) list.push(new Float32Array(2 * CHUNK_FRAMES));
    this.node.port.postMessage({ type: 'buffers', list }, list.map((b) => b.buffer));
  }

  start(atTime = this.ctx.currentTime): Promise<Take> {
    this.chunks = [];
    this.clipped = false;
    this.startFrame = Math.round(atTime * this.ctx.sampleRate);
    const maxFrames = RECORD_MAX_SECONDS * this.ctx.sampleRate;
    this.node.port.postMessage({ type: 'start', atFrame: this.startFrame, maxFrames });
    return new Promise((resolve) => { this.finish = resolve; });
  }

  stop(atTime = this.ctx.currentTime): void {
    this.node.port.postMessage({ type: 'stop', atFrame: Math.round(atTime * this.ctx.sampleRate) });
  }

  /** Called when the context leaves 'running'; finalizes from the chunks already received. */
  abort(reason: RecordStopReason): void {
    const frames = this.chunks.reduce((m, c) => Math.max(m, c.offset + c.frames), 0);
    setTimeout(() => this.resolve(frames, 0, reason), DONE_TIMEOUT_MS);
  }

  private onMessage(m: any): void {
    if (m.type === 'started') {
      this.startFrame = m.frame;
    } else if (m.type === 'chunk') {
      this.chunks.push({ offset: m.offset, frames: m.frames, data: m.data });
      this.lastPeak = m.peak;
      if (m.clipped) this.clipped = true;
      this.sendBuffers(1);
    } else if (m.type === 'done') {
      this.resolve(Math.min(m.captured, m.requested), m.dropped, m.reason);
    }
  }

  private resolve(frames: number, dropped: number, reason: RecordStopReason): void {
    if (!this.finish) return;
    const done = this.finish;
    this.finish = null;
    done({ sampleRate: this.ctx.sampleRate, frames, chunks: this.chunks, chunkFrames: CHUNK_FRAMES, dropped, reason });
  }
}
```
Elapsed time: `(ctx.currentTime * sampleRate − startedAtFrame) / sampleRate`, read once per animation frame and clamped to 600 s.

### Context state and background tabs
| Condition | Behaviour |
|---|---|
| `ctx.state` becomes `suspended` or `interrupted` during a take | `process()` stops running. Call `abort('interrupted')`, encode what was received, show the interrupted state. Up to one partial chunk (≤ 8192 frames, ≈ 171 ms at 48 kHz) may be lost. |
| iOS tab switch or screen lock; exclusive audio access or lid close in Chrome 136+ | Context moves to `interrupted`; handled as above. |
| Context `closed` or `processorerror` | Error state; chunks received so far are offered for download. |
| Desktop background tab | The audio thread keeps running; `MessagePort` delivery is task-based, not timer-based. The pool covers ≈ 2 s of main-thread stalls. |

Listen with `ctx.addEventListener('statechange', …)`; any state other than `running` during a take counts as an interruption.

### Memory
| Data | 44.1 kHz stereo | 48 kHz stereo | 10 min at 48 kHz |
|---|---|---|---|
| Capture store (float32) | 21.17 MB/min | 23.04 MB/min | 230.4 MB |
| WAV 16-bit PCM | 10.58 MB/min | 11.52 MB/min | 115.2 MB |
| WAV 32-bit float | 21.17 MB/min | 23.04 MB/min | 230.4 MB |

- Peak during encoding is the capture store plus the WAV output: 345.6 MB (16-bit) or 460.8 MB (float) for 10 min at 48 kHz.
- Encoding proceeds chunk by chunk into `Blob` parts.
- A failed allocation throws `RangeError`, which maps to the out-of-memory state.
- The RIFF 32-bit size limit (4 GiB) is not reached at the 10-minute cap.

## WAV encoding (`src/audio/recording/wav.js`)
All multi-byte fields are little-endian; written with `DataView` and `littleEndian = true`.

### 16-bit PCM (44-byte header, `WAVE_FORMAT_PCM = 1`)
| Offset | Size | Field | Value |
|---|---|---|---|
| 0 | 4 | ChunkID | `"RIFF"` |
| 4 | 4 | ChunkSize | 36 + dataBytes |
| 8 | 4 | Format | `"WAVE"` |
| 12 | 4 | Subchunk ID | `"fmt "` |
| 16 | 4 | Subchunk size | 16 |
| 20 | 2 | wFormatTag | 1 |
| 22 | 2 | nChannels | 2 |
| 24 | 4 | nSamplesPerSec | sample rate |
| 28 | 4 | nAvgBytesPerSec | sampleRate × 4 |
| 32 | 2 | nBlockAlign | 4 |
| 34 | 2 | wBitsPerSample | 16 |
| 36 | 4 | Subchunk ID | `"data"` |
| 40 | 4 | dataBytes | frames × 4 |
| 44 | … | samples | interleaved L, R `int16` |

### 32-bit float (58-byte header, `WAVE_FORMAT_IEEE_FLOAT = 3`)
Differences from the PCM header:
- `fmt ` size 18, with `cbSize = 0` at offset 36.
- `wFormatTag = 3`, `nBlockAlign = 8`, `nAvgBytesPerSec = sampleRate × 8`, `wBitsPerSample = 32`.
- `fact` chunk at offset 38: `"fact"`, size 4, `dwSampleLength` = frames per channel.
- `data` header at offset 50; samples at 58. `ChunkSize = 50 + dataBytes`.

Microsoft's WAVE revisions require a `fact` chunk and the `cbSize` field for all non-PCM formats. libsndfile writes `fact` for float files, and some players reject non-PCM files without it.

`WAVE_FORMAT_EXTENSIBLE` is required for more than two channels, for PCM precision above 16 bits, or when container size differs from valid bits. Neither output format here (16-bit PCM, IEEE float with tag 3) needs it.

### Encoder
```ts
export type WavFormat = 'pcm16' | 'float32';

export function headerSize(format: WavFormat): number {
  return format === 'float32' ? 58 : 44;
}

export function writeWavHeader(format: WavFormat, sampleRate: number, frames: number, channels = 2): ArrayBuffer {
  const isFloat = format === 'float32';
  const bits = isFloat ? 32 : 16;
  const blockAlign = (channels * bits) / 8;
  const dataBytes = frames * blockAlign;
  const size = headerSize(format);
  const v = new DataView(new ArrayBuffer(size));
  let p = 0;
  const str = (s: string) => { for (let i = 0; i < 4; i++) v.setUint8(p++, s.charCodeAt(i)); };
  const u16 = (x: number) => { v.setUint16(p, x, true); p += 2; };
  const u32 = (x: number) => { v.setUint32(p, x, true); p += 4; };
  str('RIFF'); u32(size - 8 + dataBytes); str('WAVE');
  str('fmt '); u32(isFloat ? 18 : 16);
  u16(isFloat ? 3 : 1); u16(channels); u32(sampleRate);
  u32(sampleRate * blockAlign); u16(blockAlign); u16(bits);
  if (isFloat) { u16(0); str('fact'); u32(4); u32(frames); }
  str('data'); u32(dataBytes);
  return v.buffer;
}

export interface BodyOptions { format: WavFormat; dither: boolean; rand: () => number; }

/** Encodes frames [start, start + count) of planar L/R into an interleaved body part. */
export function encodeBody(left: Float32Array, right: Float32Array, start: number, count: number, o: BodyOptions): ArrayBuffer {
  const isFloat = o.format === 'float32';
  const out = new DataView(new ArrayBuffer(count * (isFloat ? 8 : 4)));
  let p = 0;
  for (let i = start; i < start + count; i++) {
    for (let c = 0; c < 2; c++) {
      let s = c === 0 ? left[i] : right[i];
      if (!Number.isFinite(s)) s = 0;
      if (isFloat) { out.setFloat32(p, s, true); p += 4; continue; }
      if (s > 1) s = 1; else if (s < -1) s = -1;
      let x = s * 32767;
      if (o.dither) x += o.rand() - o.rand();   // TPDF, ±1 LSB peak
      let q = Math.round(x);
      if (q > 32767) q = 32767; else if (q < -32768) q = -32768;
      out.setInt16(p, q, true); p += 2;
    }
  }
  return out.buffer;
}

export function takeToWavBlob(
  take: { sampleRate: number; frames: number; chunkFrames: number; chunks: { offset: number; frames: number; data: Float32Array }[] },
  format: WavFormat, dither = true, seed = 1,
): Blob {
  const parts: BlobPart[] = [writeWavHeader(format, take.sampleRate, take.frames)];
  const opts: BodyOptions = { format, dither, rand: mulberry32(seed) };
  const bpf = format === 'float32' ? 8 : 4;
  let pos = 0;
  for (const ch of [...take.chunks].sort((a, b) => a.offset - b.offset)) {
    if (ch.offset >= take.frames) break;
    if (ch.offset > pos) { parts.push(new ArrayBuffer((ch.offset - pos) * bpf)); pos = ch.offset; } // gap → zeros
    const n = Math.min(ch.frames, take.frames - ch.offset);
    parts.push(encodeBody(ch.data.subarray(0, take.chunkFrames), ch.data.subarray(take.chunkFrames), 0, n, opts));
    pos = ch.offset + n;
  }
  if (pos < take.frames) parts.push(new ArrayBuffer((take.frames - pos) * bpf));
  return new Blob(parts, { type: 'audio/wav' });
}
```
- `mulberry32` comes from `src/audio/random.js`.
- Scale is `× 32767` (symmetric); −32768 occurs only through dither at negative full scale.
- Dither is TPDF (difference of two uniform values, ±1 LSB peak), on by default for 16-bit, never applied to float, and seeded so offline renders are reproducible.
- No resampling: `nSamplesPerSec` is always the producing context's sample rate.

## Download (`src/audio/recording/download.js`)
```ts
export const REVOKE_DELAY_MS = 30_000;   // (project limit)

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/** e.g. synth-live-20261007-143205-48k-16.wav, mysong-render-20261007-143205-48k-f32.wav */
export function wavFilename(kind: 'live' | 'render', sampleRate: number, format: 'pcm16' | 'float32', songName?: string): string {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  const base = (songName ?? 'synth').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'synth';
  const rate = sampleRate === 44100 ? '44.1k' : `${Math.round(sampleRate / 1000)}k`;
  return `${base}-${kind}-${stamp}-${rate}-${format === 'float32' ? 'f32' : '16'}.wav`;
}
```
- The success state keeps the `Blob` (not the URL) for "Download Again"; each click creates and later revokes a new object URL.
- A programmatic `a.click()` after a long asynchronous encode may be blocked outside transient user activation in some browsers; the "Download Again" button covers that case.

## Offline render (`src/audio/recording/offline-render.js`)

### Engine requirements
- `buildEngine(ctx: BaseAudioContext, seed)` builds the current patch and the safety chain. No module uses `AudioContext`-only members (`outputLatency`, `resume()`, `createMediaStreamSource`).
- All worklet modules are added to the offline context with `ctx.audioWorklet.addModule(url)` before node construction. An `addModule` rejection maps to the render error state.
- The offline chain has no meters, no recorder and no live-input nodes. `masterGain` uses the live master value.
- The scheduler's offline mode (`midi-playback-scheduling.md`) schedules events by song time with no timer.
- Voice caps and stealing apply. Occupancy is computed from scheduled note-on and note-off times, because `ctx.currentTime` stays 0 while events are scheduled.
- Granular and Karplus-Strong noise are seeded from `(renderSeed, partIndex, noteIndex)` and passed to worklets in `processorOptions`. Repeated renders in the same browser are identical; output is not bit-identical across browsers.

### Progress, windowed scheduling, cancel
- `OfflineAudioContext` has no progress event. `suspend(t)` pauses rendering at `t`, rounded down to a render-quantum boundary. Suspending twice on the same quantized frame, at or before `currentTime`, or at or after the duration, rejects with `InvalidStateError`.
- Support: Chrome 49+; Safari 14.1+; not implemented in Firefox (Bugzilla 1265406).
- With `suspend`: suspend every 1 s of song time (project limit). At each suspension, report progress, schedule the next window, schedule the next suspend, then `resume()`. Windowed scheduling bounds the number of live nodes.
- Without `suspend`: schedule the whole song before `startRendering()`; progress is indeterminate.
- Cancel: there is no abort API. With `suspend`, the next suspension handler does not resume, and the context is released for garbage collection. Without `suspend`, rendering completes and the result is discarded. In both cases the returned promise rejects with `AbortError` immediately.

```ts
import { encodeBody, writeWavHeader, type WavFormat } from './wav';
import { mulberry32 } from '../random';

export const RENDER_MAX_SONG_SECONDS = 600;  // (project limit)
export const RENDER_TAIL_SECONDS = 3;        // (project limit)
export const PROGRESS_STEP_SEC = 1;          // (project limit)
export const DEFAULT_RENDER_RATE = 48000;    // (project limit)

export interface RenderDeps {
  loadWorklets(ctx: BaseAudioContext): Promise<void>;
  buildEngine(ctx: BaseAudioContext, seed: number): Promise<{ output: AudioNode }>;
  createOfflineScheduler(ctx: BaseAudioContext): { scheduleRange(from: number, to: number): void };
}

export async function renderSongToWav(
  songDurationSec: number,
  deps: RenderDeps,
  opts: { sampleRate?: number; format: WavFormat; dither: boolean; seed: number },
  onProgress: (fraction: number | null) => void,
  signal: AbortSignal,
): Promise<Blob> {
  if (songDurationSec > RENDER_MAX_SONG_SECONDS) throw new RangeError('song-too-long');
  const sampleRate = opts.sampleRate ?? DEFAULT_RENDER_RATE;
  const totalSec = songDurationSec + RENDER_TAIL_SECONDS;
  const length = Math.ceil(totalSec * sampleRate);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });

  await deps.loadWorklets(ctx);
  const engine = await deps.buildEngine(ctx, opts.seed);
  engine.output.connect(ctx.destination);
  const scheduler = deps.createOfflineScheduler(ctx);

  if (typeof ctx.suspend === 'function') {
    scheduler.scheduleRange(0, 2 * PROGRESS_STEP_SEC);
    const plan = (t: number): void => {
      if (t >= totalSec) return;
      ctx.suspend(t).then(() => {
        if (signal.aborted) return;
        onProgress(t / totalSec);
        scheduler.scheduleRange(t + PROGRESS_STEP_SEC, t + 2 * PROGRESS_STEP_SEC);
        plan(t + PROGRESS_STEP_SEC);
        void ctx.resume();
      });
    };
    plan(PROGRESS_STEP_SEC);
  } else {
    scheduler.scheduleRange(0, Infinity);
    onProgress(null);
  }

  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Render cancelled', 'AbortError')), { once: true });
  });
  const buffer = await Promise.race([ctx.startRendering(), aborted]);
  onProgress(1);

  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const parts: BlobPart[] = [writeWavHeader(opts.format, sampleRate, buffer.length)];
  const body = { format: opts.format, dither: opts.dither, rand: mulberry32(opts.seed) };
  const STEP = 1 << 16;
  for (let i = 0; i < buffer.length; i += STEP) {
    if (signal.aborted) throw new DOMException('Render cancelled', 'AbortError');
    parts.push(encodeBody(L, R, i, Math.min(STEP, buffer.length - i), body));
  }
  return new Blob(parts, { type: 'audio/wav' });
}
```
- Length: `ceil((songDuration + 3 s) × sampleRate)`. Releases longer than the tail are truncated.
- `startRendering()` allocates the full `AudioBuffer`: 10 min + 3 s at 48 kHz is 231.6 MB of float32, plus the WAV output. `NotSupportedError` or `RangeError` during construction or rendering maps to the out-of-memory state.

## UI
Record and its indicator sit in the transport's Master group. Render to WAV and its progress sit in the Song group. Format is in the File menu (`layout-and-responsive.md`). Component rules are in `controls-and-accessibility.md`. Recording UI does not use the accent colour, and every state is conveyed by text.

| Control | Specification |
|---|---|
| Record | `<button aria-pressed>` labelled "Record", icon plus text. Disabled while rendering. |
| Recording indicator | Text "REC" and elapsed/limit `02:13 / 10:00`. The dot glyph is `aria-hidden`. |
| Format | Two `menuitemradio` items in the File menu: "WAV 16-Bit" (default), "WAV 32-Bit Float". Shared by both modes; disabled during capture. |
| Peak | Text "Peak −3.2 dB" from chunk `peak`; "Clip" badge when `clipped`. |
| Render to WAV | Enabled only when a MIDI file is loaded; disabled while recording. |
| Render progress | `<progress max="100" aria-label="Render progress">` with text "Rendering 42 %"; no `value` (indeterminate) without `suspend`. |
| Cancel | Visible during rendering and encoding. |

| State | Status text |
|---|---|
| Recording | "Recording" |
| Saving | "Saving WAV…" |
| Rendering | "Rendering 42 %" / "Rendering…" |
| Success | "Download started: {filename}", with "Download Again" |
| Maximum length | "Recording stopped at the 10:00 limit. Download started." |
| Interrupted | "Recording stopped: audio was interrupted. Captured audio was saved." |
| Out of memory | "Not enough memory to create the WAV file." |
| Song too long | "Songs longer than 10:00 cannot be rendered." |
| Cancelled | "Render cancelled." |

- State changes go to the polite live region; per-second time updates do not.
- No single-letter shortcut is bound to Record, because letter keys play notes (`live-input.md`).

## Browser support
| Capability | Chrome | Firefox | Safari |
|---|---|---|---|
| AudioWorklet | 66 | 76 | 14.1 |
| `OfflineAudioContext.suspend()` | 49 | No | 14.1 |
| AudioWorklet in `OfflineAudioContext` | Yes | Yes | Yes |
| `interrupted` context state | 136 | No | Yes (iOS) |

## Unconfirmed behaviour
- Whether the worklet's message handler runs while the context is `suspended` or `interrupted` (covered by `abort()` after 500 ms).

## Sources
- W3C, Web Audio API 1.1: AudioWorkletProcessor, OfflineAudioContext, `renderSizeHint` (https://www.w3.org/TR/webaudio-1.1/)
- MDN, AudioWorkletNode, AudioWorkletProcessor.process(), AudioWorkletGlobalScope.currentFrame, OfflineAudioContext.suspend(), BaseAudioContext.state (https://developer.mozilla.org/)
- Chrome for Developers, "Web audio updates in Chrome 49" (https://developer.chrome.com/blog/webaudio)
- Mozilla Bugzilla 1265406, OfflineAudioContext suspend/resume (https://bugzilla.mozilla.org/show_bug.cgi?id=1265406)
- IBM/Microsoft, Multimedia Programming Interface and Data Specifications 1.0 (1991); Microsoft, New Multimedia Data Types and Data Techniques, Rev. 3
- McGill University, WAVE File Specifications (https://www-mmsp.ece.mcgill.ca/Documents/AudioFormats/WAVE/WAVE.html)
- Microsoft Learn, WAVEFORMATEXTENSIBLE (https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatextensible)
- EarLevel Engineering, "What is dither?" (https://www.earlevel.com/main/1996/10/20/what-is-dither/)
