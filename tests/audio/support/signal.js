/** Signal-analysis helpers for DSP tests. */

/** Magnitude of `freq` in `buf[start, start + n)` by Goertzel over a Hann window, normalised so a unit sine gives ~0.5. */
export function toneMagnitude(buf, freq, fs, start = 0, n = buf.length - start) {
  const w = (2 * Math.PI * freq) / fs;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    wsum += hann;
    const s0 = buf[start + i] * hann + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const re = s1 - s2 * Math.cos(w);
  const im = s2 * Math.sin(w);
  return Math.sqrt(re * re + im * im) / wsum;
}

/** Frequency of a near-sinusoid from interpolated rising zero crossings over [start, start + n). */
export function zeroCrossingFrequency(buf, fs, start = 0, n = buf.length - start) {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = start + 1; i < start + n; i++) {
    if (buf[i - 1] < 0 && buf[i] >= 0) {
      const t = i - 1 + -buf[i - 1] / (buf[i] - buf[i - 1]);
      if (first < 0) first = t;
      else count++;
      last = t;
    }
  }
  return (count * fs) / (last - first);
}

/** Peak absolute value over [start, end). */
export function peak(buf, start = 0, end = buf.length) {
  let p = 0;
  for (let i = start; i < end; i++) p = Math.max(p, Math.abs(buf[i]));
  return p;
}

/** Cents between frequencies a and b. */
export function cents(a, b) {
  return 1200 * Math.log2(a / b);
}
