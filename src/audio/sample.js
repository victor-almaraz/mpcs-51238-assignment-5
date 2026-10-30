// User samples for the granular source (synthesis-granular.md "User sample";
// audio-safety.md "User samples"). A file is decoded, mixed to mono, truncated, cleaned of
// DC, faded at the edges and levelled so it is never louder (peak or RMS) than the
// generated sources. The result is an AudioBuffer; it is not stored in patches.

export const MAX_SAMPLE_BYTES = 4 * 1024 * 1024;
export const MAX_SAMPLE_SECONDS = 20;
const DECODE_RATE = 48000;
const TARGET_PEAK = 1;                 // the generated saw and noise peak at 1
const MAX_RMS = 1 / Math.sqrt(3);      // RMS of a full-scale saw or uniform noise
const SILENCE = 1e-4;                  // −80 dBFS peak
const FADE_S = 0.005;
const DC_HZ = 10;

export class SampleError extends Error {}

/**
 * Turns decoded channels into one conditioned mono channel.
 * @param {Float32Array[]} channels  decoded audio, all the same length
 * @param {number} sampleRate
 * @returns {{data: Float32Array, truncated: boolean}}
 * @throws {SampleError} when there is no audio or it is silent
 */
export function conditionSample(channels, sampleRate) {
  if (channels.length === 0 || channels[0].length === 0) throw new SampleError('the file has no audio');
  const n = Math.min(channels[0].length, Math.round(MAX_SAMPLE_SECONDS * sampleRate));
  const out = new Float32Array(n);

  // Mono mix; non-finite samples count as 0.
  const k = 1 / channels.length;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const x = ch[i];
      if (Number.isFinite(x)) out[i] += x * k;
    }
  }

  // DC: remove the mean, then a one-pole high-pass at 10 Hz for drifting offsets.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += out[i];
  const mean = sum / n;
  const r = 1 - (2 * Math.PI * DC_HZ) / sampleRate;
  let x1 = 0, y1 = 0;
  for (let i = 0; i < n; i++) {
    const x = out[i] - mean;
    const y = x - x1 + r * y1;
    x1 = x;
    y1 = y;
    out[i] = y;
  }

  // 5 ms fades so grains taken at the edges, and the truncation point, do not click.
  const fade = Math.min(Math.round(FADE_S * sampleRate), n >> 1);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] *= g;
    out[n - 1 - i] *= g;
  }

  // Level: up or down to a peak of 1, but never above the generated sources' RMS.
  let peak = 0, sq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
    sq += out[i] * out[i];
  }
  if (peak < SILENCE) throw new SampleError('the file is silent');
  const rms = Math.sqrt(sq / n);
  const gain = Math.min(TARGET_PEAK / peak, MAX_RMS / rms);
  for (let i = 0; i < n; i++) out[i] *= gain;

  return { data: out, truncated: channels[0].length > n };
}

/**
 * Decodes and conditions a user's audio file. Needs no running AudioContext.
 * @param {File} file
 * @returns {Promise<{buffer: AudioBuffer, name: string, seconds: number, truncated: boolean}>}
 * @throws {SampleError}
 */
export async function decodeSample(file) {
  if (file.size > MAX_SAMPLE_BYTES) throw new SampleError('the file is larger than 4 MB');
  const bytes = await file.arrayBuffer();
  let decoded;
  try {
    decoded = await new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(bytes);
  } catch {
    throw new SampleError('this browser cannot decode the file');
  }
  const channels = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  const { data, truncated } = conditionSample(channels, decoded.sampleRate);
  const buffer = new AudioBuffer({ length: data.length, numberOfChannels: 1, sampleRate: decoded.sampleRate });
  buffer.copyToChannel(data, 0);
  return { buffer, name: file.name, seconds: data.length / decoded.sampleRate, truncated };
}
