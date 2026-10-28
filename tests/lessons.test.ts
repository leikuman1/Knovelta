import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkLessons, collectReview, localDay, parseLessons, promoteLesson } from '../scripts/lessons';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(dates = ['2026-01-01']) {
  const root = mkdtempSync(path.join(tmpdir(), 'knovelta-lessons-')); dirs.push(root);
  mkdirSync(path.join(root, 'docs'));
  const records = dates.map((date, i) => `  - ${date} | record:docs/lessons-evidence.md#event-${i} | 独立事件 ${i}`);
  writeFileSync(path.join(root, 'LESSONS.md'), `# Lessons\n\n<!-- lesson:L001 -->\n<a id="l001"></a>\n### L001 · 测试经验\n\n- 问题键：\`test-problem\`\n- 规则：先验证状态。\n- 原因：时间不代表状态。\n- 证据：\n${records.join('\n')}\n<!-- /lesson -->\n\n## 已晋升索引\n`);
  writeFileSync(path.join(root, 'docs/code-standards.md'), '# 代码规范\n\n暂无符合条件的经验。\n');
  writeFileSync(path.join(root, 'docs/lessons-evidence.md'), dates.map((_, i) => `<a id="event-${i}"></a>\n## R${i}\n说明`).join('\n'));
  return root;
}
function update(root: string, transform: (input: string) => string) {
  const file = path.join(root, 'LESSONS.md'); writeFileSync(file, transform(readFileSync(file, 'utf8')));
}
function git(root: string, args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }); }

describe('经验积累工作流', () => {
  it('校验只读且重复复盘不修改经验', () => {
    const root = fixture(); const before = readFileSync(path.join(root, 'LESSONS.md'), 'utf8');
    expect(checkLessons(root)).toEqual({ active: 1, promoted: 0, eligible: [] });
    checkLessons(root); expect(readFileSync(path.join(root, 'LESSONS.md'), 'utf8')).toBe(before);
  });
  it('拒绝重复编号和同类问题键', () => {
    const root = fixture(); const block = parseLessons(readFileSync(path.join(root, 'LESSONS.md'), 'utf8'))[0].block;
    update(root, text => `${text}\n${block.replaceAll('L001', 'L002').replace('id="l001"', 'id="l002"')}\n`);
    expect(() => checkLessons(root)).toThrow('重复经验');
  });
  it('同一事件换日期仍不增加出现次数', () => {
    const root = fixture(['2026-01-01', '2026-01-02']);
    update(root, text => text.replace('event-1', 'event-0'));
    expect(() => checkLessons(root)).toThrow('重复引用');
  });
  it('同日多个事件不满足三个日期，不能晋升且不改文件', () => {
    const root = fixture(['2026-01-01', '2026-01-01', '2026-01-01']);
    const before = readFileSync(path.join(root, 'LESSONS.md'), 'utf8');
    expect(() => promoteLesson(root, 'L001')).toThrow('1 个不同发生日期');
    expect(readFileSync(path.join(root, 'LESSONS.md'), 'utf8')).toBe(before);
  });
  it('三个独立日期后移动规则、保留引用，重复晋升拒绝', () => {
    const root = fixture(['2026-01-01', '2026-01-02', '2026-01-03']);
    expect(checkLessons(root).eligible).toEqual(['L001']);
    promoteLesson(root, 'L001'); expect(checkLessons(root)).toEqual({ active: 0, promoted: 1, eligible: [] });
    expect(readFileSync(path.join(root, 'LESSONS.md'), 'utf8')).toContain('docs/code-standards.md#l001');
    expect(parseLessons(readFileSync(path.join(root, 'docs/code-standards.md'), 'utf8'))[0].evidence).toHaveLength(3);
    expect(() => promoteLesson(root, 'L001')).toThrow('未找到');
  });
  it('缺失证据、路径穿越、未来日期和损坏标记均拒绝', () => {
    const root = fixture();
    const original = readFileSync(path.join(root, 'LESSONS.md'), 'utf8');
    for (const bad of [original.replace('#event-0', '#missing'), original.replace('docs/lessons-evidence.md', 'docs/../secret.md'), original.replace('2026-01-01', '2999-01-01'), original.replace('<!-- /lesson -->', '')]) {
      writeFileSync(path.join(root, 'LESSONS.md'), bad); expect(() => checkLessons(root)).toThrow();
    }
  });
  it('容量限制阻止无限增长', () => {
    const root = fixture(); update(root, text => text + '\n'.repeat(351));
    expect(() => checkLessons(root)).toThrow('超出');
  });
  it('事件记录的发生日期不可被复盘日期替换', () => {
    const root = fixture();
    writeFileSync(path.join(root, 'docs/lessons-evidence.md'), '<a id="event-0"></a>\n## R0\n- 发生日期：2026-01-02，Asia/Shanghai。\n');
    expect(() => checkLessons(root)).toThrow('日期与事件记录不一致');
  });
  it('按年归档同样受容量限制', () => {
    const root = fixture(); mkdirSync(path.join(root, 'docs/lessons-archive'));
    writeFileSync(path.join(root, 'docs/lessons-archive/2026.md'), '# 归档\n' + '\n'.repeat(300));
    expect(() => checkLessons(root)).toThrow('归档 2026.md 超出');
  });
  it('Asia/Shanghai 日期在 UTC 午夜附近保持准确', () => {
    expect(localDay(new Date('2026-10-26T16:01:00Z'))).toBe('2026-10-27');
  });
  it('收集当天 Git 证据并验证 commit 引用，两次收集不写文件', () => {
    const root = fixture();
    git(root, ['init', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fix: fixture evidence']);
    const commit = git(root, ['rev-parse', 'HEAD']).trim();
    update(root, text => text.replace('record:docs/lessons-evidence.md#event-0', `commit:${commit}`));
    expect(checkLessons(root).active).toBe(1);
    const before = readFileSync(path.join(root, 'LESSONS.md'), 'utf8');
    const report = collectReview(root, localDay());
    expect(report).toContain(commit); expect(report).toContain('fix: fixture evidence'); expect(report).toContain('测试代码不等于测试已运行');
    expect(collectReview(root, localDay())).toBe(report);
    expect(readFileSync(path.join(root, 'LESSONS.md'), 'utf8')).toBe(before);
  });
});
