import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLine, resolveWindowsCommand } from '../dist/spawn-command.js';

// resolveWindowsCommand only runs on Windows in the proxy, but its search
// order is plain logic over the file system, so it is tested everywhere
// (with exact-case file names, since other file systems are case-sensitive).
async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-tape-resolve-'));
  const cwd = join(root, 'cwd');
  const a = join(root, 'a');
  const b = join(root, 'b');
  for (const d of [cwd, a, b]) await mkdir(d);
  return { root, cwd, a, b };
}

test('a bare name is tried with each PATHEXT extension, PATH in order', async () => {
  const { root, cwd, a, b } = await layout();
  try {
    await writeFile(join(b, 'tool.EXE'), '');
    await writeFile(join(a, 'tool.CMD'), '');
    const env = { PATH: `${a};${b}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    // Directory order wins over extension order.
    assert.equal(resolveWindowsCommand('tool', env, cwd), join(a, 'tool.CMD'));
    await writeFile(join(a, 'tool.EXE'), '');
    assert.equal(resolveWindowsCommand('tool', env, cwd), join(a, 'tool.EXE'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the current directory comes first unless NoDefaultCurrentDirectoryInExePath is set', async () => {
  const { root, cwd, a } = await layout();
  try {
    await writeFile(join(cwd, 'tool.CMD'), '');
    await writeFile(join(a, 'tool.CMD'), '');
    const env = { Path: a, PATHEXT: '.CMD' };
    assert.equal(resolveWindowsCommand('tool', env, cwd), join(cwd, 'tool.CMD'));
    assert.equal(
      resolveWindowsCommand('tool', { ...env, NoDefaultCurrentDirectoryInExePath: '1' }, cwd),
      join(a, 'tool.CMD'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a name with an extension is looked for as given; a missing name is null', async () => {
  const { root, cwd, a } = await layout();
  try {
    await writeFile(join(a, 'run.bat'), '');
    const env = { PATH: `"${a}"`, PATHEXT: '.EXE' };
    assert.equal(resolveWindowsCommand('run.bat', env, cwd), join(a, 'run.bat'));
    assert.equal(resolveWindowsCommand('run', env, cwd), null);
    assert.equal(resolveWindowsCommand('nothing-here', env, cwd), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a name with a directory part is resolved against cwd only', async () => {
  const { root, cwd, a } = await layout();
  try {
    await mkdir(join(cwd, 'bin'));
    await writeFile(join(cwd, 'bin', 'serve.CMD'), '');
    await writeFile(join(a, 'serve.CMD'), '');
    const env = { PATH: a, PATHEXT: '.CMD' };
    assert.equal(resolveWindowsCommand('bin/serve', env, cwd), join(cwd, 'bin', 'serve.CMD'));
    assert.equal(resolveWindowsCommand('other/serve', env, cwd), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cmdLine quotes every argument and escapes cmd.exe metacharacters', () => {
  assert.equal(
    cmdLine('C:\\Program Files\\nodejs\\npx.cmd', ['-y', 'a b', '', 'x&y', 'q"x', 'C:\\dir\\'], false),
    'C:\\Program^ Files\\nodejs\\npx.cmd ^"-y^" ^"a^ b^" ^"^" ^"x^&y^" ^"q\\^"x^" ^"C:\\dir\\\\^"',
  );
});

test('cmdLine escapes twice for a batch file that forwards %*', () => {
  assert.equal(cmdLine('C:\\bin\\shim.cmd', ['a b', '%P%'], true), 'C:\\bin\\shim.cmd ^^^"a^^^ b^^^" ^^^"^^^%P^^^%^^^"');
});
