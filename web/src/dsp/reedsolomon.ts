// Reed-Solomon over GF(2^8), matching the Python `reedsolo` library's defaults
// (prim 0x11d, generator 2, fcr 0, nsize 255) so encoded bytes are identical.
// Ported from the standard "Reed-Solomon for coders" algorithm reedsolo uses.

const PRIM = 0x11d;
const GENERATOR = 2;
const FIELD = 255;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < FIELD; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM; // multiply by generator (2), reduce mod prim
  }
  for (let i = FIELD; i < 512; i++) EXP[i] = EXP[i - FIELD]; // doubled, avoids mod
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}
function gfPow(a: number, power: number): number {
  return EXP[(((LOG[a] * power) % FIELD) + FIELD) % FIELD];
}
function gfInverse(a: number): number {
  return EXP[FIELD - LOG[a]];
}
function gfPolyMul(p: number[], q: number[]): number[] {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++)
    for (let i = 0; i < p.length; i++) r[i + j] ^= gfMul(p[i], q[j]);
  return r;
}
function gfPolyEval(poly: ArrayLike<number>, x: number): number {
  let y = poly[0];
  for (let i = 1; i < poly.length; i++) y = gfMul(y, x) ^ poly[i];
  return y;
}

function generatorPoly(nsym: number): number[] {
  let g = [1];
  for (let i = 0; i < nsym; i++) g = gfPolyMul(g, [1, gfPow(GENERATOR, i)]); // fcr = 0
  return g;
}

function encodeMsg(msg: Uint8Array, nsym: number): Uint8Array {
  const gen = generatorPoly(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg, 0);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef !== 0) for (let j = 1; j < gen.length; j++) out[i + j] ^= gfMul(gen[j], coef);
  }
  out.set(msg, 0); // the division loop corrupted the message region; restore it
  return out;
}

/** RS-encode arbitrary-length data, chunked by (255 - nsym) like reedsolo. */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  const k = FIELD - nsym;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += k) parts.push(encodeMsg(data.subarray(i, Math.min(i + k, data.length)), nsym));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ── decode (error-correcting), ported faithfully from reedsolo/Wikiversity ──
function gfPolyScale(p: number[], x: number): number[] {
  return p.map((c) => gfMul(c, x));
}
function gfPolyAdd(p: number[], q: number[]): number[] {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}
function calcSyndromes(msg: Uint8Array, nsym: number): number[] {
  const s = [0];
  for (let i = 0; i < nsym; i++) s.push(gfPolyEval(msg, gfPow(GENERATOR, i)));
  return s;
}
function findErrorLocator(synd: number[], nsym: number): number[] {
  // Berlekamp-Massey
  let errLoc = [1];
  let oldLoc = [1];
  const syndShift = synd.length > nsym ? synd.length - nsym : 0;
  for (let i = 0; i < nsym; i++) {
    const K = i + syndShift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    oldLoc = oldLoc.concat([0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = gfPolyScale(oldLoc, delta);
        oldLoc = gfPolyScale(errLoc, gfInverse(delta));
        errLoc = newLoc;
      }
      errLoc = gfPolyAdd(errLoc, gfPolyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  return errLoc;
}
function findErrors(errLocReversed: number[], nmess: number): number[] {
  const errs = errLocReversed.length - 1;
  const pos: number[] = [];
  for (let i = 0; i < nmess; i++) if (gfPolyEval(errLocReversed, gfPow(GENERATOR, i)) === 0) pos.push(nmess - 1 - i);
  if (pos.length !== errs) throw new Error(`RS: could not locate errors (${errs} expected, ${pos.length} found)`);
  return pos;
}
function findErrataLocator(coefPos: number[]): number[] {
  let eLoc = [1];
  for (const p of coefPos) eLoc = gfPolyMul(eLoc, gfPolyAdd([1], [gfPow(GENERATOR, p), 0]));
  return eLoc;
}
function findErrorEvaluator(syndReversed: number[], errLoc: number[], nsym: number): number[] {
  const remainder = gfPolyMul(syndReversed, errLoc);
  return remainder.slice(remainder.length - (nsym + 1));
}
function correctErrata(msg: Uint8Array, synd: number[], errPos: number[]): Uint8Array {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  const errLoc = findErrataLocator(coefPos);
  const errEval = findErrorEvaluator(synd.slice().reverse(), errLoc, errLoc.length - 1).reverse();
  const X = coefPos.map((p) => gfPow(GENERATOR, p));
  const E = new Uint8Array(msg.length);
  for (let i = 0; i < X.length; i++) {
    const Xi = X[i];
    const XiInv = gfInverse(Xi);
    let errLocPrime = 1; // formal derivative of the errata locator at Xi^-1
    for (let j = 0; j < X.length; j++) if (j !== i) errLocPrime = gfMul(errLocPrime, 1 ^ gfMul(XiInv, X[j]));
    if (errLocPrime === 0) throw new Error("RS: Forney denominator zero");
    let y = gfPolyEval(errEval.slice().reverse(), XiInv);
    y = gfMul(gfPow(Xi, 1), y); // fcr = 0
    E[errPos[i]] = gfMul(y, gfInverse(errLocPrime));
  }
  const out = Uint8Array.from(msg);
  for (let i = 0; i < out.length; i++) out[i] ^= E[i];
  return out;
}
function decodeMsg(msg: Uint8Array, nsym: number): Uint8Array {
  const synd = calcSyndromes(msg, nsym);
  if (synd.every((x) => x === 0)) return msg.subarray(0, msg.length - nsym);
  const errLoc = findErrorLocator(synd, nsym);
  const errPos = findErrors(errLoc.slice().reverse(), msg.length);
  const corrected = correctErrata(msg, synd, errPos);
  if (!calcSyndromes(corrected, nsym).every((x) => x === 0)) throw new Error("RS: decode failed to correct");
  return corrected.subarray(0, corrected.length - nsym);
}

/** RS-decode (and error-correct) a stream encoded by rsEncode. Throws if a
 * chunk has more errors than it can correct. */
export function rsDecode(data: Uint8Array, nsym: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += FIELD) parts.push(decodeMsg(data.subarray(i, Math.min(i + FIELD, data.length)), nsym));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
