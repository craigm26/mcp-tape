#!/usr/bin/env node
// A child for the proxy lifecycle tests. argv[2] names the behaviour; every
// scenario writes newline-delimited JSON on stdout.

const scenario = process.argv[2] ?? 'echo';
const out = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

switch (scenario) {
  // Echo each input line back inside {"echo": ...}. At end of input, say
  // goodbye on a final line without LF and exit 0. A server like this only
  // exits once its stdin is closed.
  case 'echo': {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          out(JSON.stringify({ echo: JSON.parse(line) }) + '\n');
        } catch {}
      }
    });
    process.stdin.on('end', () => {
      out('{"bye":true}');
      process.exit(0);
    });
    break;
  }

  // Exit at once with status 3, without reading stdin.
  case 'exit-now': {
    out('{"hello":1}\n');
    process.exitCode = 3;
    break;
  }

  // One line whose multi-byte characters are split across separate writes.
  case 'split-utf8': {
    const bytes = Buffer.from(JSON.stringify({ s: 'é€😀' }) + '\n', 'utf8');
    const cuts = [7, 9, 12, 14, bytes.length];
    let from = 0;
    for (const to of cuts) {
      out(bytes.subarray(from, to));
      from = to;
      await sleep(30);
    }
    break;
  }

  // A 2 MB message whose payload is one base64 word, then one more message.
  case 'blob': {
    out(JSON.stringify({ data: 'QUJD'.repeat(512 * 1024) }) + '\n');
    out('{"after":1}\n');
    break;
  }

  // End by a signal.
  case 'signal': {
    out('{"bye":"signal"}\n');
    process.kill(process.pid, process.argv[3] ?? 'SIGUSR2');
    await sleep(5000);
    break;
  }

  // Start a helper that inherits stdout and outlives this process, then exit:
  // the pipe stays open after the server has gone.
  case 'helper-holds-stdout': {
    const { spawn } = await import('node:child_process');
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: ['ignore', 'inherit', 'ignore'],
    });
    out(JSON.stringify({ helper: helper.pid }) + '\n');
    helper.unref();
    break;
  }

  // Print the arguments after the scenario name, then exit.
  case 'args': {
    out(JSON.stringify({ args: process.argv.slice(3) }) + '\n');
    break;
  }

  default:
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exitCode = 1;
}
