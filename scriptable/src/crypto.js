// ---------------------------------------------------------------- hashing
// The Pure box hashes the login with MD5 or SHA-512. Scriptable has no crypto
// library, so both are implemented here. SHA-512 constants are derived at start-up
// (cube/square roots of primes) rather than typed in, so there are no typos.

function utf8Bytes(str) {
  const s = unescape(encodeURIComponent(str));
  const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function md5(str) {
  const bytes = utf8Bytes(str);
  const T = [];
  for (let i = 0; i < 64; i++) T[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const len = bytes.length;
  const msg = bytes.slice();
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  const bits = len * 8;
  for (let i = 0; i < 8; i++) msg.push(i < 4 ? (bits >>> (8 * i)) & 0xff : Math.floor(bits / 2 ** (8 * i)) & 0xff);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < msg.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = (msg[j] | (msg[j + 1] << 8) | (msg[j + 2] << 16) | (msg[j + 3] << 24)) >>> 0;
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const s = S[(i >> 4) * 4 + (i % 4)];
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + T[i] + M[g]) >>> 0;
      B = (B + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  let hex = "";
  for (const w of [a0, b0, c0, d0]) for (let i = 0; i < 4; i++) hex += ((w >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
  return hex;
}

const SHA512 = (() => {
  const MASK = (1n << 64n) - 1n;
  const primes = [];
  for (let n = 2; primes.length < 80; n++) if (primes.every((p) => n % p)) primes.push(n);
  const iroot = (v, k) => { // integer k-th root by Newton's method
    let x = 1n << BigInt(Math.ceil(v.toString(2).length / k) + 1);
    for (;;) {
      const y = ((BigInt(k) - 1n) * x + v / x ** (BigInt(k) - 1n)) / BigInt(k);
      if (y >= x) return x;
      x = y;
    }
  };
  const K = primes.map((p) => iroot(BigInt(p) << 192n, 3) & MASK);
  const H = primes.slice(0, 8).map((p) => iroot(BigInt(p) << 128n, 2) & MASK);
  const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & MASK;
  return { K, H, MASK, rotr };
})();

function sha512(str) {
  const { K, H, MASK, rotr } = SHA512;
  const bytes = utf8Bytes(str);
  const len = bytes.length;
  const msg = bytes.slice();
  msg.push(0x80);
  while (msg.length % 128 !== 112) msg.push(0);
  const bitLen = BigInt(len) * 8n;
  for (let i = 15; i >= 0; i--) msg.push(Number((bitLen >> BigInt(8 * i)) & 0xffn));
  const h = H.slice();
  for (let off = 0; off < msg.length; off += 128) {
    const W = new Array(80);
    for (let i = 0; i < 16; i++) {
      let w = 0n;
      for (let j = 0; j < 8; j++) w = (w << 8n) | BigInt(msg[off + i * 8 + j]);
      W[i] = w;
    }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr(W[i - 15], 1n) ^ rotr(W[i - 15], 8n) ^ (W[i - 15] >> 7n);
      const s1 = rotr(W[i - 2], 19n) ^ rotr(W[i - 2], 61n) ^ (W[i - 2] >> 6n);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) & MASK;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (~e & MASK & g);
      const t1 = (hh + S1 + ch + K[i] + W[i]) & MASK;
      const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & MASK;
      hh = g; g = f; f = e; e = (d + t1) & MASK; d = c; c = b; b = a; a = (t1 + t2) & MASK;
    }
    const v = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + v[i]) & MASK;
  }
  return h.map((x) => x.toString(16).padStart(16, "0")).join("");
}
