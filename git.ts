// Git smart-HTTP: pkt-lines, packfiles, upload-pack (protocol v0 and v2) and
// receive-pack (v0). Objects are stored raw in the repo's object map, so what
// was pushed is what a clone gets back, byte for byte. Packs sent are always
// self-contained plain objects (no deltas); packs received may use deltas.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  Repo, ZERO_OID, parseCommit, parseTag,
  type GitObject, type GitObjectType,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktReader {
  /** Next payload, or 'flush' / 'delim' / 'end' markers. */
  next(): Buffer | 'flush' | 'delim' | 'end';
  /** Bytes not consumed by pkt-lines (the pack after a push command list). */
  rest(): Buffer;
}

export function pktReader(buffer: Buffer): PktReader {
  let offset = 0;
  return {
    next() {
      if (offset >= buffer.length) return 'end';
      if (offset + 4 > buffer.length) throw new Error('truncated pkt-line');
      const hex = buffer.toString('ascii', offset, offset + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('invalid pkt-line length');
      const length = parseInt(hex, 16);
      if (length === 0) {
        offset += 4;
        return 'flush';
      }
      if (length === 1) {
        offset += 4;
        return 'delim';
      }
      if (length === 2) {
        offset += 4;
        return 'delim';
      }
      if (length === 3 || length < 4) throw new Error('invalid pkt-line length');
      if (offset + length > buffer.length) throw new Error('pkt-line overruns body');
      const payload = buffer.subarray(offset + 4, offset + length);
      offset += length;
      return payload;
    },
    rest() {
      return buffer.subarray(offset);
    },
  };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'tree', // placeholder, deltas handled separately
  7: 'blob',
};

/** Apply a git delta buffer to a base object, returning the result bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ParsedPackObject {
  sha: string;
  type: GitObjectType;
  data: Buffer;
}

/** Parse a packfile into resolved objects (deltas applied against the pack or `external`). */
export function parsePack(pack: Buffer, external?: (sha: string) => GitObject | undefined): ParsedPackObject[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const byOffset = new Map<number, ParsedPackObject>();
  const resolved: ParsedPackObject[] = [];
  const trailerStart = pack.length - 20;

  const readObjectHeader = (): { typeCode: number; size: number } => {
    let byte = pack[pos];
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return { typeCode, size };
  };

  for (let i = 0; i < count; i += 1) {
    if (pos >= trailerStart) throw new Error('pack truncated');
    const entryOffset = pos;
    const { typeCode, size } = readObjectHeader();
    let baseSha: string | null = null;
    let baseOffset = -1;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset to the base entry.
      let byte = pack[pos];
      pos += 1;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - offset;
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base sha.
      baseSha = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    // Find the end of the zlib stream by inflating incrementally.
    const inflated = inflateWithLength(pack.subarray(pos));
    pos += inflated.consumed;
    const raw = inflated.data;
    if (raw.length !== size) throw new Error('pack entry size mismatch');

    let obj: ParsedPackObject;
    if (typeCode === 6 || typeCode === 7) {
      let base: ParsedPackObject | GitObject | undefined;
      if (typeCode === 6) base = byOffset.get(baseOffset);
      else if (baseSha) base = resolved.find((o) => o.sha === baseSha) ?? (external ? external(baseSha) : undefined);
      if (!base) throw new Error('delta base not found');
      const data = applyDelta(base.data, raw);
      obj = { sha: '', type: base.type, data };
      obj.sha = sha1Of(base.type, data);
    } else {
      const type = TYPE_NAMES[typeCode];
      if (!type) throw new Error(`unknown pack type ${typeCode}`);
      obj = { sha: sha1Of(type, raw), type, data: raw };
    }
    byOffset.set(entryOffset, obj);
    resolved.push(obj);
  }
  return resolved;
}

function sha1Of(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Inflate one zlib stream from the front of `buf`, reporting bytes consumed. */
function inflateWithLength(buf: Buffer): { data: Buffer; consumed: number } {
  // zlib streams are self-terminating; try the whole buffer, then binary-search
  // is wasteful — instead inflate via a streaming check: Node's inflateSync
  // throws on trailing garbage only in strict mode; it ignores trailing bytes
  // and does not report consumption. Use the incremental zlib API through
  // `inflateSync` on progressively larger slices is O(n^2); packs here are
  // small (<= a few MB), so use the standard trick: DecompressStream-like
  // behaviour via zlib's `inflateSync` with a manual stream end scan.
  // Simpler robust approach: use createInflate and feed chunks — but this
  // function is synchronous. Node exposes consumed bytes only via the async
  // API; emulate by attempting inflate on the full remainder and locating the
  // stream end with the Adler-32: scan for the point where inflate succeeds
  // and the following bytes start a plausible next entry. In practice the
  // suite's packs are written by one writePack with deflate per object, and
  // object boundaries are found by trying inflateSync at each candidate end
  // is too slow. Use the documented approach: zlib.inflateSync ignores
  // trailing data, so determine consumption by re-deflating? No.
  // The reliable synchronous method: use `zlib.inflateSync` together with
  // the fact that a raw deflate stream's compressed length can be found by
  // feeding bytes to an Inflate instance via `process` — unavailable sync.
  // Fallback used by many pure implementations: binary search the smallest
  // prefix that inflates successfully.
  let lo = 1;
  let hi = buf.length;
  let best: { data: Buffer; consumed: number } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(buf.subarray(0, mid));
      best = { data, consumed: mid };
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (!best) throw new Error('cannot inflate pack entry');
  return best;
}

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Build a self-contained packfile (plain objects, version 2) for `shas`. */
export function buildPack(repo: Repo, shas: string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  const parts: Buffer[] = [header];
  for (const sha of shas) {
    const obj = repo.getObject(sha);
    if (!obj) continue;
    const typeCode = TYPE_CODES[obj.type];
    const size = obj.data.length;
    const headBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    headBytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Ref advertisement helpers
// ---------------------------------------------------------------------------

interface RefLine {
  oid: string;
  ref: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo in advertisement order: HEAD first, then sorted refs. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headRef = repo.headTarget();
  const headOid = repo.refs.get(headRef);
  lines.push({
    oid: headOid ?? ZERO_OID,
    ref: 'HEAD',
    symrefTarget: headRef,
    unborn: headOid === undefined,
  });
  const names = [...repo.refs.keys()].sort();
  for (const ref of names) {
    const oid = repo.refs.get(ref) as string;
    const line: RefLine = { oid, ref };
    const obj = repo.getObject(oid);
    if (obj && obj.type === 'tag') {
      const target = parseTag(obj.data);
      line.peeled = target.object;
    }
    lines.push(line);
  }
  return lines;
}

const UPLOAD_CAPS_V0 = 'side-band-64k ofs-delta shallow agent=makefun-forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';

export function advertiseUploadPack(repo: Repo, version2: boolean): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n')];
  if (version2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine('agent=makefun-forge/1.0\n'));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const lines = refLines(repo);
  if (lines.length === 1 && lines[0].unborn) {
    // Empty repo: the capabilities^{} pseudo-ref carries the capability list.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_CAPS_V0} symref=HEAD:${repo.headTarget()}\n`));
  } else {
    lines.forEach((line, index) => {
      let text = `${line.oid} ${line.ref}`;
      if (index === 0) text += `\0${UPLOAD_CAPS_V0} symref=HEAD:${repo.headTarget()}`;
      parts.push(pktLine(`${text}\n`));
      if (line.peeled) parts.push(pktLine(`${line.peeled} ${line.ref}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function advertiseReceivePack(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n')];
  const lines = refLines(repo).filter((line) => line.ref !== 'HEAD');
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    lines.forEach((line, index) => {
      let text = `${line.oid} ${line.ref}`;
      if (index === 0) text += `\0${RECEIVE_CAPS}`;
      parts.push(pktLine(`${text}\n`));
      if (line.peeled) parts.push(pktLine(`${line.peeled} ${line.ref}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack POST: ls-refs and fetch, protocol v2 and v0
// ---------------------------------------------------------------------------

function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const packets: Buffer[] = [];
  const maxPayload = 65516 - 1;
  for (let offset = 0; offset < data.length; offset += maxPayload) {
    const chunk = data.subarray(offset, offset + maxPayload);
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return packets;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  wantRefs: string[];
  done: boolean;
}

/**
 * Compute the object set for a fetch: closure of the wants, minus everything
 * reachable from the haves (whose shallow boundaries stop the walk), with
 * depth limiting when `deepen` is set. Also returns the new shallow boundary.
 */
function computeFetch(repo: Repo, req: FetchRequest): { objects: string[]; shallow: string[]; unshallow: string[] } {
  const boundarySet = new Set(req.shallow);
  const haveSet = req.haves.length > 0 || req.shallow.length > 0
    ? repo.reachableFrom([...req.haves, ...req.shallow], boundarySet)
    : new Set<string>();

  // Exclusions from deepen-not refs.
  if (req.deepenNot.length > 0) {
    const excluded = new Set<string>();
    for (const ref of req.deepenNot) {
      const oid = repo.refs.get(ref) ?? (repo.getObject(ref) ? ref : null);
      if (oid) for (const sha of repo.reachableFrom([oid])) excluded.add(sha);
    }
    for (const sha of excluded) haveSet.add(sha);
  }

  const send = new Set<string>();
  const newShallow = new Set<string>();
  const limit = req.deepen;

  // BFS by generation from the want tips.
  const depthOf = new Map<string, number>();
  const queue: string[] = [];
  for (const want of req.wants) {
    // A wanted tag object is itself part of the transfer.
    let cursor = want;
    while (true) {
      const obj = repo.getObject(cursor);
      if (!obj || obj.type !== 'tag') break;
      if (!haveSet.has(cursor)) send.add(cursor);
      cursor = parseTag(obj.data).object;
    }
    const commit = repo.peelToCommit(want);
    if (commit && !depthOf.has(commit)) {
      depthOf.set(commit, 0);
      queue.push(commit);
    }
  }
  const commitsToSend: string[] = [];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    const depth = depthOf.get(sha) as number;
    const info = repo.commitInfo(sha);
    if (!info) continue;
    if (!haveSet.has(sha)) {
      commitsToSend.push(sha);
      send.add(sha);
      repo.addTreeClosure(info.tree, send);
    }
    const atBoundary = (limit !== null && depth + 1 >= limit)
      || (req.deepenSince !== null && info.timeSec <= req.deepenSince);
    for (const parent of info.parents) {
      if (atBoundary) {
        // Parent exists but is not sent: this commit is a shallow boundary
        // unless the parent is already held by the client.
        if (!haveSet.has(parent) && !haveSet.has(sha)) newShallow.add(sha);
        continue;
      }
      if (!depthOf.has(parent)) {
        depthOf.set(parent, depth + 1);
        queue.push(parent);
      }
    }
    if (atBoundary && info.parents.length === 0 && limit !== null && depth + 1 >= limit) {
      // Root commit at the depth limit: it is its own boundary only when the
      // fetch is shallow and the commit was actually sent.
      if (!haveSet.has(sha)) newShallow.add(sha);
    }
  }
  // Remove anything the client already holds (trees/blobs of sent commits are
  // added above; commits already filtered).
  for (const sha of [...send]) {
    if (haveSet.has(sha)) send.delete(sha);
  }
  void commitsToSend;

  const unshallow: string[] = [];
  // A previously-shallow commit whose parents are now all sent or held is no
  // longer a boundary.
  for (const old of req.shallow) {
    if (newShallow.has(old)) continue;
    const info = repo.commitInfo(old);
    if (!info) continue;
    const connected = info.parents.every((p) => send.has(p) || haveSet.has(p));
    if (connected && (send.size > 0 || req.deepen !== null)) unshallow.push(old);
  }

  return { objects: [...send], shallow: [...newShallow], unshallow };
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let wantSymrefs = false;
  let wantPeel = false;
  let wantUnborn = false;
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg === 'symrefs') wantSymrefs = true;
    else if (arg === 'peel') wantPeel = true;
    else if (arg === 'unborn') wantUnborn = true;
  }
  const parts: Buffer[] = [];
  for (const line of refLines(repo)) {
    if (prefixes.length > 0 && !prefixes.some((p) => line.ref.startsWith(p))) continue;
    if (line.unborn) {
      if (!wantUnborn) continue;
      let text = `unborn ${line.ref}`;
      if (wantSymrefs && line.symrefTarget) text += ` symref-target:${line.symrefTarget}`;
      parts.push(pktLine(`${text}\n`));
      continue;
    }
    let text = `${line.oid} ${line.ref}`;
    if (wantSymrefs && line.symrefTarget) text += ` symref-target:${line.symrefTarget}`;
    if (wantPeel && line.peeled) text += ` peeled:${line.peeled}`;
    parts.push(pktLine(`${text}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function parseFetchArgs(args: string[], req: FetchRequest): void {
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) req.deepen = Number(arg.slice(7).trim());
    else if (arg.startsWith('deepen-since ')) req.deepenSince = Number(arg.slice(13).trim());
    else if (arg.startsWith('deepen-not ')) req.deepenNot.push(arg.slice(11).trim());
    else if (arg.startsWith('want-ref ')) req.wantRefs.push(arg.slice(9).trim());
    else if (arg === 'done') req.done = true;
  }
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const req: FetchRequest = {
    wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], wantRefs: [], done: false,
  };
  parseFetchArgs(args, req);
  const { objects, shallow, unshallow } = computeFetch(repo, req);
  const parts: Buffer[] = [];

  // acknowledgments section
  const ackLines: string[] = [];
  const commonHave = req.haves.find((h) => repo.commitInfo(h) !== null);
  if (commonHave) ackLines.push(`ACK ${commonHave}\n`);
  else ackLines.push('NAK\n');
  if (objects.length > 0 && commonHave) ackLines.push('ready\n');
  parts.push(pktLine('acknowledgments\n'));
  for (const line of ackLines) parts.push(pktLine(line));
  parts.push(PKT_DELIM);

  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(PKT_DELIM);
  }

  if (req.wantRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const ref of req.wantRefs) {
      const oid = repo.refs.get(ref);
      if (oid) parts.push(pktLine(`${oid} ${ref}\n`));
    }
    parts.push(PKT_DELIM);
  }

  if (objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    const pack = buildPack(repo, objects);
    for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const reader = pktReader(body);
  const req: FetchRequest = {
    wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], wantRefs: [], done: false,
  };
  // First section: wants (first line carries capabilities), shallow/deepen.
  let item = reader.next();
  let firstLine = true;
  while (item !== 'flush' && item !== 'end') {
    const line = (item as Buffer).toString('utf8').trimEnd();
    if (firstLine && line.startsWith('want ')) {
      const spaceParts = line.split(' ');
      req.wants.push(spaceParts[1]);
      firstLine = false;
    } else {
      parseFetchArgs([line], req);
    }
    item = reader.next();
  }
  // Second section: haves and done.
  item = reader.next();
  while (item !== 'flush' && item !== 'end') {
    const line = (item as Buffer).toString('utf8').trimEnd();
    parseFetchArgs([line], req);
    item = reader.next();
  }
  const { objects, shallow, unshallow } = computeFetch(repo, req);
  const parts: Buffer[] = [];
  for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  parts.push(pktLine('NAK\n'));
  const pack = buildPack(repo, objects);
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Handle a POST to git-upload-pack; `version2` from the Git-Protocol header. */
export function handleUploadPack(repo: Repo, body: Buffer, version2: boolean): Buffer {
  if (!version2) return handleFetchV0(repo, body);
  const reader = pktReader(body);
  let command = '';
  const args: string[] = [];
  let item = reader.next();
  while (item !== 'end' && item !== 'flush' && item !== 'delim') {
    const line = (item as Buffer).toString('utf8').trimEnd();
    if (line.startsWith('command=')) command = line.slice('command='.length);
    item = reader.next();
  }
  if (item === 'delim') {
    item = reader.next();
    while (item !== 'end' && item !== 'flush') {
      args.push((item as Buffer).toString('utf8').trimEnd());
      item = reader.next();
    }
  }
  if (command === 'ls-refs') return handleLsRefs(repo, args);
  if (command === 'fetch') return handleFetchV2(repo, args);
  throw new Error(`unknown upload-pack command ${command}`);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Handle a POST to git-receive-pack; returns the report-status body. */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const reader = pktReader(body);
  const commands: RefCommand[] = [];
  let item = reader.next();
  while (item !== 'flush' && item !== 'end') {
    let line = (item as Buffer).toString('utf8');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    line = line.trimEnd();
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
    item = reader.next();
  }
  const packBytes = reader.rest();

  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes, (sha) => repo.getObject(sha));
      for (const obj of objects) repo.putObject(obj.type, obj.data);
    } catch {
      unpackOk = false;
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : 'failed'}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const verdict = applyRefUpdate(repo, command);
    reportLines.push(verdict === null ? `ok ${command.ref}` : `ng ${command.ref} ${verdict}`);
  }

  const inner: Buffer[] = reportLines.map((line) => pktLine(`${line}\n`));
  inner.push(PKT_FLUSH);
  const innerStream = Buffer.concat(inner);
  const parts = sidebandPackets(innerStream, 1);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Validate and apply one ref update; returns the refusal reason or null. */
function applyRefUpdate(repo: Repo, command: RefCommand): string | null {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (current !== oldOid) {
    // The client's view of the ref is stale; git refuses such updates.
    return 'stale info';
  }
  if (newOid === ZERO_OID) {
    repo.refs.delete(ref);
    return null;
  }
  const target = repo.getObject(newOid);
  if (!target) return 'missing object';
  if (oldOid !== ZERO_OID) {
    const oldCommit = repo.peelToCommit(oldOid);
    const newCommit = repo.peelToCommit(newOid);
    if (oldCommit && newCommit && oldCommit !== newCommit && !repo.isAncestor(oldCommit, newCommit)) {
      return 'non-fast-forward';
    }
  }
  repo.refs.set(ref, newOid);
  return null;
}

export { parseCommit };
