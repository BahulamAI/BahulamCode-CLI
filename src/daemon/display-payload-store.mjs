/** Bounded, private presentation cache. Never changes the canonical session JSONL. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sanitizeEventValue } from '../core/history-event-value.mjs';
import { sanitizeDisplayValue } from '../core/display-sanitize.mjs';
import { bahulamHome } from '../core/paths.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const MiB = 1024 * 1024;
export class DisplayPayloadStore {
  constructor({ directory = path.join(bahulamHome(), 'cache', 'display-payloads'), memoryLimit = 16 * MiB,
    diskLimit = 256 * MiB, maxPayload = 64 * MiB, maxAgeMs = 14 * 86400000 } = {}) {
    Object.assign(this, { directory, memoryLimit, diskLimit, maxPayload, maxAgeMs });
    this.memory = new Map();
    this.memoryBytes = 0;
    this.pendingBytes = 0;
    this.queue = Promise.resolve();
    this.writes = 0;
    this.diskBytes = 0;
  }
  remember(ref, text) {
    if (this.memory.has(ref)) return;
    const bytes = Buffer.byteLength(text);
    if (bytes > this.memoryLimit) return;
    while (this.memoryBytes + bytes > this.memoryLimit || this.memory.size >= 128) {
      const key = this.memory.keys().next().value;
      this.memoryBytes -= Buffer.byteLength(this.memory.get(key));
      this.memory.delete(key);
    }
    this.memory.set(ref, text);
    this.memoryBytes += bytes;
  }
  async directoryReady() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid display cache directory');
  }
  eventKey(sessionId, event) {
    const canonical = sanitizeEventValue(sanitizeDisplayValue({type:event.type,data:event.data || {}}));
    return `index-${hash(sessionId)}-${hash(JSON.stringify(canonical))}.json`;
  }
  put(sessionId, text, event) {
    const bytes = Buffer.byteLength(text);
    if (bytes > this.maxPayload || bytes > this.diskLimit || this.pendingBytes + bytes > 64 * MiB) return undefined;
    const ref = `display:${hash(sessionId)}:${hash(text)}`;
    this.remember(ref, text);
    this.pendingBytes += bytes;
    this.queue = this.queue.then(async () => {
      await this.directoryReady();
      const name = ref.replaceAll(':', '-') + '.json';
      const temporary = path.join(this.directory, `${name}.${process.pid}.tmp`);
      try {
        await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, path.join(this.directory, name));
      } finally { await fs.rm(temporary, { force: true }); }
      this.diskBytes += bytes;
      if (event) {
        const alias = path.join(this.directory, this.eventKey(sessionId,event));
        try { await fs.writeFile(alias,JSON.stringify({ref}),{flag:'wx',mode:0o600}); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const stat=await fs.lstat(alias);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size>4096) throw new Error('invalid cache index');
          const prior=JSON.parse(await fs.readFile(alias,'utf8'));
          // Identical truncated history can represent distinct full outputs. Never guess.
          if (prior.ref && prior.ref!==ref) await fs.writeFile(alias,'{"ambiguous":true}',{mode:0o600});
        }
        this.diskBytes += 256;
      }
      if (this.writes++ % 32 === 0 || this.diskBytes > this.diskLimit) await this.prune();
    }).catch(() => {
      // Cache I/O must not interrupt the agent. A failed lookup reports unavailability.
    }).finally(() => { this.pendingBytes -= bytes; });
    return ref;
  }
  async prune() {
    const entries = [];
    for (const name of await fs.readdir(this.directory)) {
      if (!/^(?:display|index)-[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(this.directory, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      entries.push({ file, size: stat.size, time: stat.mtimeMs });
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    entries.sort((a, b) => a.time - b.time);
    let remaining=entries.length;
    for (const entry of entries) {
      if (remaining <= 4096 && total <= this.diskLimit && Date.now() - entry.time <= this.maxAgeMs) continue;
      await fs.unlink(entry.file);
      total -= entry.size;
      remaining--;
    }
    this.diskBytes=total;
  }
  async indexForSession(sessionId) {
    await this.queue;
    try { return new Set((await fs.readdir(this.directory)).filter(name=>name.startsWith(`index-${hash(sessionId)}-`))); }
    catch { return new Set(); }
  }
  async referenceForEvent(event, sessionId, index) {
    if (index?.size===0) return undefined;
    const name=this.eventKey(sessionId,event);
    if (index && !index.has(name)) return undefined;
    await this.queue;
    try {
      const root=await fs.lstat(this.directory);
      const file=path.join(this.directory,name), stat=await fs.lstat(file);
      if (!root.isDirectory() || root.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size>4096 || Date.now()-stat.mtimeMs>this.maxAgeMs) return undefined;
      const value=JSON.parse(await fs.readFile(file,'utf8'));
      if (value.ambiguous || !new RegExp(`^display:${hash(sessionId)}:[a-f0-9]{64}$`).test(value.ref)) return undefined;
      return value.ref;
    } catch {return undefined;}
  }
  async get(ref, sessionId) {
    if (!new RegExp(`^display:${hash(sessionId)}:[a-f0-9]{64}$`).test(ref)) return undefined;
    const cached = this.memory.get(ref);
    if (cached) return JSON.parse(cached);
    await this.queue;
    try {
      const file = path.join(this.directory, ref.replaceAll(':', '-') + '.json');
      const root = await fs.lstat(this.directory);
      const stat = await fs.lstat(file);
      if (!root.isDirectory() || root.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()
        || stat.size > this.maxPayload || Date.now() - stat.mtimeMs > this.maxAgeMs) return undefined;
      const text = await fs.readFile(file, 'utf8');
      if (hash(text) !== ref.split(':')[2]) return undefined;
      const data = JSON.parse(text);
      this.remember(ref, text);
      return data;
    } catch { return undefined; }
  }
  async flush() { await this.queue; }
}
let store;
export function displayPayloadStore() { return store ||= new DisplayPayloadStore(); }
