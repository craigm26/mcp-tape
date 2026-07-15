import { join } from 'node:path';
import { RotatingWriter } from './rotation.js';

interface OpenOpts {
  dir: string;
  label: string;
  command: readonly string[];
  version: string;
  maxBytes: number;
  maxFiles: number;
  onFrame?: (line: unknown) => void;
  // When true, the writer does not touch disk — meta, message, and end frames
  // are still produced and pushed through onFrame, but no .jsonl is written.
  // Used by `mcp-tape --serve --no-file`.
  noFile?: boolean;
}

export class TraceWriter {
  private constructor(
    private readonly rot: RotatingWriter | null,
    readonly path: string | null,
    private readonly startedAt: number,
    private readonly onFrame?: (line: unknown) => void,
  ) {}

  static async open(opts: OpenOpts): Promise<TraceWriter> {
    let rot: RotatingWriter | null = null;
    let path: string | null = null;
    if (!opts.noFile) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${ts}-${sanitize(opts.label)}.jsonl`;
      path = join(opts.dir, filename);
      rot = await RotatingWriter.open({
        path,
        maxBytes: opts.maxBytes,
        maxFiles: opts.maxFiles,
      });
    }
    const startedAt = Date.now();
    const w = new TraceWriter(rot, path, startedAt, opts.onFrame);
    await w.writeLine({
      v: 1,
      type: 'meta',
      startedAt: new Date(startedAt).toISOString(),
      label: opts.label,
      command: [...opts.command],
      mcpTapVersion: opts.version,
    });
    return w;
  }

  async logMessage(dir: 'in' | 'out', raw: unknown): Promise<void> {
    await this.writeLine({ t: new Date().toISOString(), dir, raw });
  }

  async close(exitCode: number): Promise<void> {
    await this.writeLine({
      t: new Date().toISOString(),
      type: 'end',
      exitCode,
      durationMs: Date.now() - this.startedAt,
    });
    if (this.rot) await this.rot.close();
  }

  private async writeLine(obj: unknown): Promise<void> {
    if (this.onFrame) {
      try {
        this.onFrame(obj);
      } catch {
        // Broadcast failure must never suppress disk persistence. The frame
        // is already redacted at this point; losing the live wire is
        // tolerable, losing the trace file is not.
      }
    }
    if (this.rot) await this.rot.writeLine(JSON.stringify(obj) + '\n');
  }
}

function sanitize(label: string): string {
  return label.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'mcp';
}
