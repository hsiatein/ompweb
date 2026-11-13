import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';

test('workspace file editing and management preserve data and authorization', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-file-edit-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  const sid = '550e8400-e29b-41d4-a716-446655440000';
  const sessionDir = path.join(root, 'agent', 'sessions', 'fixture');
  fs.mkdirSync(sessionDir, { recursive: true });
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'read-only reference');
  fs.writeFileSync(path.join(sessionDir, `${sid}.jsonl`), [
    { type: 'session', id: sid, version: 3, cwd },
    { type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: [{ type: 'text', text: `[outside](${outside})` }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__piAllowedRootsCache;
    delete globalThis.__piAdditionalAllowedRoots;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const routes = await jiti.import('../app/api/files/[...path]/route.ts');
  const { NextRequest } = await jiti.import('next/server');
  const { allowFileRoot } = await jiti.import('./file-access.ts');
  const { TEXT_PREVIEW_MAX_BYTES } = await jiti.import('./file-types.ts');
  const request = (file, method = 'GET', body, type = 'edit') => routes[method](new NextRequest(`http://localhost/api/files/${file.split(path.sep).filter(Boolean).map(encodeURIComponent).join('/')}?type=${type}&sessionId=${sid}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  }), { params: Promise.resolve({ path: file.split(path.sep).filter(Boolean) }) });
  const file = path.join(cwd, 'script.sh');

  await t.test('saving preserves Unicode, UTF-8 BOM, CRLF, executable mode and rejects stale revisions', async () => {
    fs.writeFileSync(file, '\ufeffecho 你好\r\n', { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    const original = await (await request(file)).json();
    assert.equal(original.content, '\ufeffecho 你好\n');
    const saved = await request(file, 'PUT', { revision: original.revision, content: '\ufeffecho 世界\n' });
    assert.equal(saved.status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), '\ufeffecho 世界\r\n');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    const stale = await request(file, 'PUT', { revision: original.revision, content: 'stale overwrite' });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'file_edit_conflict');
    assert.equal(fs.readFileSync(file, 'utf8'), '\ufeffecho 世界\r\n');
    assert.deepEqual(fs.readdirSync(cwd), ['script.sh']);
  });

  await t.test('same-size external changes cannot be overwritten even with restored timestamps', async () => {
    fs.writeFileSync(file, 'first');
    const loaded = await (await request(file)).json();
    const stat = fs.statSync(file);
    fs.writeFileSync(file, 'other');
    fs.utimesSync(file, stat.atime, stat.mtime);
    assert.equal((await request(file, 'PUT', { revision: loaded.revision, content: 'mine' })).status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), 'other');
  });

  await t.test('live previews observe successive atomic saves, not only the first inode replacement', async () => {
    const response = await request(file, 'GET', undefined, 'watch');
    const reader = response.body.getReader();
    const readEvent = async () => {
      let timer;
      try {
        const chunk = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No file watch event')), 2000); })]);
        return new TextDecoder().decode(chunk.value);
      } finally { clearTimeout(timer); }
    };
    try {
      assert.match(await readEvent(), /event: connected/);
      for (const content of ['first atomic save', 'second atomic save with more text']) {
        const loaded = await (await request(file)).json();
        assert.equal((await request(file, 'PUT', { content, revision: loaded.revision })).status, 200);
        const event = await readEvent();
        const data = JSON.parse(event.split('data: ')[1].trim());
        assert.equal(data.size, Buffer.byteLength(content));
      }
    } finally { await reader.cancel(); }
  });

  await t.test('external session references remain read-only for every mutation', async () => {
    assert.equal((await request(outside, 'GET', undefined, 'read')).status, 200);
    assert.equal((await request(outside)).status, 403);
    assert.equal((await request(outside, 'PUT', { content: 'changed', revision: 'a'.repeat(64) })).status, 403);
    assert.equal((await request(outside, 'PATCH', { action: 'rename', name: 'renamed.txt' })).status, 403);
    assert.equal((await request(outside, 'DELETE')).status, 403);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'read-only reference');
  });

  await t.test('new entries reject traversal and existing targets; rename retains contents', async () => {
    assert.equal((await request(cwd, 'PATCH', { action: 'create-directory', name: 'notes' })).status, 201);
    const folder = path.join(cwd, 'notes');
    assert.equal((await request(folder, 'PATCH', { action: 'create-file', name: 'a.md' })).status, 201);
    const note = path.join(folder, 'a.md');
    fs.writeFileSync(note, '# keep');
    assert.equal((await request(folder, 'PATCH', { action: 'create-file', name: 'a.md' })).status, 409);
    assert.equal((await request(folder, 'PATCH', { action: 'create-file', name: '../escape.md' })).status, 400);
    fs.writeFileSync(path.join(folder, 'taken.md'), 'taken');
    assert.equal((await request(note, 'PATCH', { action: 'rename', name: 'taken.md' })).status, 409);
    assert.equal((await request(note, 'PATCH', { action: 'rename', name: 'b.md' })).status, 200);
    assert.equal(fs.readFileSync(path.join(folder, 'b.md'), 'utf8'), '# keep');
    assert.equal(fs.readFileSync(path.join(folder, 'taken.md'), 'utf8'), 'taken');
    assert.equal((await request(folder, 'PATCH', { action: 'rename', name: 'renamed' })).status, 200);
    assert.equal(fs.readFileSync(path.join(cwd, 'renamed', 'b.md'), 'utf8'), '# keep');
    assert.equal((await request(path.join(cwd, 'renamed'), 'DELETE')).status, 200);
    assert.equal(fs.existsSync(path.join(cwd, 'renamed')), false);
  });

  await t.test('binary, invalid UTF-8 and oversized text cannot enter the editor or overwrite a text file', async () => {
    for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xff]), Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1, 65)]) {
      const bad = path.join(cwd, 'bad.txt');
      fs.writeFileSync(bad, bytes);
      assert.ok([400, 413].includes((await request(bad)).status));
    }
    // Over the auto-load limit: refused by default, readable on request but never editable.
    const large = path.join(cwd, 'large.log');
    fs.writeFileSync(large, Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1, 65));
    const refused = await request(large, 'GET', undefined, 'read');
    assert.equal(refused.status, 413);
    assert.deepEqual(Object.fromEntries(Object.entries(await refused.json()).filter(([key]) => ['code', 'size', 'forceable'].includes(key))), { code: 'file_too_large_preview', size: TEXT_PREVIEW_MAX_BYTES + 1, forceable: true });
    const forced = await request(large, 'GET', undefined, 'read&force=1');
    assert.equal(forced.status, 200);
    const forcedBody = await forced.json();
    assert.equal(forcedBody.size, TEXT_PREVIEW_MAX_BYTES + 1);
    assert.equal(forcedBody.editable, false);
    fs.rmSync(large);
    const loaded = await (await request(file)).json();
    assert.equal((await request(file, 'PUT', { revision: loaded.revision, content: 'x'.repeat(TEXT_PREVIEW_MAX_BYTES + 1) })).status, 413);
    assert.equal(fs.readFileSync(file, 'utf8'), loaded.content);
  });

  await t.test('workspace roots and parents of nested roots cannot be renamed or deleted', async () => {
    const parent = path.join(cwd, 'protected');
    const nested = path.join(parent, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    allowFileRoot(nested);
    for (const target of [cwd, parent, nested]) {
      assert.equal((await request(target, 'DELETE')).status, 403);
      assert.equal((await request(target, 'PATCH', { action: 'rename', name: 'moved' })).status, 403);
      assert.equal(fs.existsSync(target), true);
    }
  });

  await t.test('symlinks cannot redirect editing or creation outside the workspace', async (s) => {
    const link = path.join(cwd, 'link');
    try { fs.symlinkSync(root, link, 'dir'); } catch (error) {
      if (error.code === 'EPERM') { s.skip('Symlink permission unavailable'); return; }
      throw error;
    }
    assert.equal((await request(link, 'PATCH', { action: 'create-file', name: 'escaped.txt' })).status, 403);
    const fileLink = path.join(cwd, 'linked.txt');
    fs.symlinkSync(outside, fileLink);
    assert.equal((await request(fileLink)).status, 400);
    assert.equal((await request(fileLink, 'DELETE')).status, 400);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'read-only reference');
    assert.equal(fs.existsSync(path.join(root, 'escaped.txt')), false);
  });
});
