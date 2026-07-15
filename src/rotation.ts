import { open, rename, unlink, type FileHandle } from 'node:fs/promises';

export interface RotationOpts {
  path: string;
  maxBytes: number;
  maxFiles: number;
}

export class RotatingWriter {
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private fh: FileHandle,
    private readonly opts: RotationOpts,
    private size: number,
  ) {}

  static async open(opts: RotationOpts): Promise<RotatingWriter> {
    const fh = await open(opts.path, 'a');
    const stat = await fh.stat();
    return new RotatingWriter(fh, opts, stat.size);
  }

  writeLine(line: string): Promise<void> {
    const next = this.writeChain.then(() => this.writeOne(line));
    // Don't poison the chain for future calls if this one rejects.
    this.writeChain = next.catch(() => {});
    return next;
  }

  async sync(): Promise<void> {
    await this.writeChain.catch(() => {});
    await this.fh.sync();
  }

  async close(): Promise<void> {
    await this.writeChain.catch(() => {});
    await this.fh.sync();
    await this.fh.close();
  }

  private async writeOne(line: string): Promise<void> {
    const buf = Buffer.from(line, 'utf8');
    if (this.size + buf.length > this.opts.maxBytes && this.size > 0) {
      await this.rotate();
    }
    await this.fh.write(buf);
    this.size += buf.length;
  }

  private async rotate(): Promise<void> {
    await this.fh.sync();
    await this.fh.close();
    await unlink(`${this.opts.path}.${this.opts.maxFiles}`).catch(() => {});
    for (let i = this.opts.maxFiles; i >= 1; i--) {
      const from = i === 1 ? this.opts.path : `${this.opts.path}.${i - 1}`;
      const to = `${this.opts.path}.${i}`;
      await rename(from, to).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      });
    }
    this.fh = await open(this.opts.path, 'a');
    this.size = 0;
  }
}
