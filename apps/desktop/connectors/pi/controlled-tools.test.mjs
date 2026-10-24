import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  validateControlledPath,
  createControlledReadTool,
  createControlledWriteTool,
  createControlledEditTool
} from './controlled-tools.mjs';

test('controlled-tools: 受控只读工具验证（read）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tool-read-'));
  const testSubDir = path.join(tmpDir, 'sub');
  fs.mkdirSync(testSubDir, { recursive: true });

  const validFile = path.join(testSubDir, 'hello.txt');
  fs.writeFileSync(validFile, 'hello from pi test', 'utf8');

  const outsideFile = path.join(tmpDir, 'outside.txt');
  fs.writeFileSync(outsideFile, 'secret outside file', 'utf8');

  const envFile = path.join(testSubDir, '.env');
  fs.writeFileSync(envFile, 'SECRET_KEY=123', 'utf8');

  try {
    const tool = createControlledReadTool(testSubDir);

    // 1. 读取正常文件成功
    const res1 = await tool.execute({ path: 'hello.txt' });
    assert.equal(res1.ok, true);
    assert.match(res1.content, /hello from pi test/);

    // 2. 相对路径越界拦截
    const res2 = await tool.execute({ path: '../outside.txt' });
    assert.equal(res2.ok, false);
    assert.match(res2.error, /越界拒绝/);

    // 3. 绝对路径外部读取拦截
    const res3 = await tool.execute({ path: outsideFile });
    assert.equal(res3.ok, false);
    assert.match(res3.error, /越界拒绝/);

    // 4. 敏感文件拦截
    const res4 = await tool.execute({ path: '.env' });
    assert.equal(res4.ok, false);
    assert.match(res4.error, /敏感保护/);

    // 5. 读取目录被拦截
    const res5 = await tool.execute({ path: testSubDir });
    assert.equal(res5.ok, false);
    assert.match(res5.error, /常规文件/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('controlled-tools: 受控新建文件工具验证（write）- 允许新建、创建子目录，拒绝覆盖已存在文件与越界', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tool-write-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const outsideSentinel = path.join(tmpDir, 'outside_sentinel.txt');
  fs.writeFileSync(outsideSentinel, 'SENTINEL_UNCHANGED', 'utf8');

  try {
    const writeTool = createControlledWriteTool(workspace);

    // 1. 新建合法文件并创建子目录
    const res1 = await writeTool.execute('w1', { path: 'docs/note.md', content: '# My Note\nInitial text' });
    assert.equal(res1.isError, undefined);
    const createdPath = path.join(workspace, 'docs', 'note.md');
    assert.ok(fs.existsSync(createdPath));
    assert.equal(fs.readFileSync(createdPath, 'utf8'), '# My Note\nInitial text');

    // 2. 核心防御：目标文件已存在时明确拒绝覆盖！
    await assert.rejects(
      async () => {
        await writeTool.execute('w2', { path: 'docs/note.md', content: '# Overwrite Attempt' });
      },
      /目标文件已存在.*write 工具仅用于创建新文件/
    );
    // 断言原文件内容保持不变
    assert.equal(fs.readFileSync(createdPath, 'utf8'), '# My Note\nInitial text');

    // 3. 相对路径越界拦截
    await assert.rejects(
      async () => {
        await writeTool.execute('w3', { path: '../outside_hack.txt', content: 'hack' });
      },
      /越界拒绝/
    );
    assert.equal(fs.existsSync(path.join(tmpDir, 'outside_hack.txt')), false);

    // 4. 绝对路径外部写拦截
    await assert.rejects(
      async () => {
        await writeTool.execute('w4', { path: outsideSentinel, content: 'HACKED' });
      },
      /越界拒绝|目标文件已存在/
    );
    assert.equal(fs.readFileSync(outsideSentinel, 'utf8'), 'SENTINEL_UNCHANGED');

    // 5. 敏感文件拦截
    await assert.rejects(
      async () => {
        await writeTool.execute('w5', { path: '.env', content: 'SECRET=123' });
      },
      /敏感保护/
    );
    assert.equal(fs.existsSync(path.join(workspace, '.env')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('controlled-tools: 受控精确编辑工具验证（edit）- 精确匹配、唯一性要求、保持未改部分、失败不改文件', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tool-edit-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const targetFile = path.join(workspace, 'checklist.md');
  const initialContent = '# 阅读角\n\n- 预算：180元\n- 任务：采买台灯\n- 任务：整理书架\n';
  fs.writeFileSync(targetFile, initialContent, 'utf8');

  try {
    const editTool = createControlledEditTool(workspace);

    // 1. 成功精确修改：将“预算：180元”改为“预算：160元”
    const res1 = await editTool.execute('e1', {
      path: 'checklist.md',
      edits: [{ oldText: '预算：180元', newText: '预算：160元' }]
    });
    assert.equal(res1.isError, undefined);
    assert.match(res1.content[0].text, /Successfully replaced 1 block/);

    const updatedContent = fs.readFileSync(targetFile, 'utf8');
    assert.equal(updatedContent, '# 阅读角\n\n- 预算：160元\n- 任务：采买台灯\n- 任务：整理书架\n');

    // 2. 匹配失败（找不到 oldText）：报错且原文件保持不变
    await assert.rejects(
      async () => {
        await editTool.execute('e2', {
          path: 'checklist.md',
          edits: [{ oldText: '不存在的预算文本', newText: '新文本' }]
        });
      },
      /Could not find/i
    );
    assert.equal(fs.readFileSync(targetFile, 'utf8'), updatedContent);

    // 3. 匹配不唯一（多次出现相同的 oldText）：报错且原文件保持不变
    // 在文件中写入两行重复的“- 任务：”
    await assert.rejects(
      async () => {
        await editTool.execute('e3', {
          path: 'checklist.md',
          edits: [{ oldText: '- 任务：', newText: '- 变更：' }]
        });
      },
      /Found \d+ occurrences/i
    );
    assert.equal(fs.readFileSync(targetFile, 'utf8'), updatedContent);

    // 4. 编辑不存在的文件报错
    await assert.rejects(
      async () => {
        await editTool.execute('e4', {
          path: 'not_found.md',
          edits: [{ oldText: 'a', newText: 'b' }]
        });
      },
      /文件不存在|Could not edit file/
    );

    // 5. 试图编辑工作区外部文件拦截
    const outsideSecret = path.join(tmpDir, 'outside_secret.txt');
    fs.writeFileSync(outsideSecret, 'DO_NOT_EDIT', 'utf8');
    await assert.rejects(
      async () => {
        await editTool.execute('e5', {
          path: '../outside_secret.txt',
          edits: [{ oldText: 'DO_NOT_EDIT', newText: 'HACKED' }]
        });
      },
      /越界拒绝/
    );
    assert.equal(fs.readFileSync(outsideSecret, 'utf8'), 'DO_NOT_EDIT');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('controlled-tools: 工单33返修验证 - 大小写受保护目录、内部Junction别名安全检查与并发创建防覆盖', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tool-order33-'));
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  try {
    const writeTool = createControlledWriteTool(workspace);
    const readTool = createControlledReadTool(workspace);

    // 1. Windows 大小写不敏感受保护目录拦截 (.GIT)
    await assert.rejects(
      async () => {
        await writeTool.execute('c1', { path: '.GIT/case-created.txt', content: 'SYNTHETIC' });
      },
      /受保护目录/
    );
    assert.equal(fs.existsSync(path.join(workspace, '.git')), false);
    assert.equal(fs.existsSync(path.join(workspace, '.GIT')), false);

    // 2. 内部 Junction 别名指向受保护目录：禁止读取与新建
    const protectedDir = path.join(workspace, '.git');
    fs.mkdirSync(protectedDir, { recursive: true });
    fs.writeFileSync(path.join(protectedDir, 'config.txt'), 'SYNTHETIC_PROTECTED_CONTENT', 'utf8');
    const junctionAlias = path.join(workspace, 'innocent-alias');
    fs.symlinkSync(protectedDir, junctionAlias, 'junction');

    // 2.1 尝试通过 innocent-alias 读取受保护目录内的文件
    const readRes = await readTool.execute({ path: 'innocent-alias/config.txt' });
    assert.equal(readRes.ok, false);
    assert.match(readRes.error, /受保护目录/);

    // 2.2 尝试通过 innocent-alias 在受保护目录内新建文件
    await assert.rejects(
      async () => {
        await writeTool.execute('c2', { path: 'innocent-alias/created.txt', content: 'SYNTHETIC' });
      },
      /受保护目录/
    );
    assert.equal(fs.existsSync(path.join(protectedDir, 'created.txt')), false);

    // 3. 并发创建防覆盖原子性保证
    const raceTarget = path.join(workspace, 'concurrent-user-file.txt');
    const originalWrite = fs.promises.writeFile;
    fs.promises.writeFile = async function(file, ...args) {
      const r = await originalWrite.call(this, file, ...args);
      if (path.dirname(String(file)) === workspace && path.basename(String(file)).startsWith('.tmp_')) {
        fs.writeFileSync(raceTarget, 'EXISTING_USER_CONTENT', { flag: 'wx' });
      }
      return r;
    };

    let raceFailed = false;
    try {
      await writeTool.execute('c3', { path: raceTarget, content: 'MODEL_REPLACEMENT' });
    } catch (err) {
      raceFailed = true;
      assert.match(err.message, /已存在|禁止覆盖/);
    } finally {
      fs.promises.writeFile = originalWrite;
    }

    assert.equal(raceFailed, true, '并发存在的目标文件必须导致 write 失败');
    assert.equal(fs.readFileSync(raceTarget, 'utf8'), 'EXISTING_USER_CONTENT', '已存在的目标内容必须得到完整保全');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
