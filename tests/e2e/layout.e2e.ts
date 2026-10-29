import { expect, test } from '@playwright/test';

test('手机面板可切换，输入示例只填草稿，页面不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '工作面板' });
  await page.getByRole('button', { name: '记下一个发现', exact: false }).click();
  await expect(page.getByRole('textbox', { name: '输入知识或问题' })).toHaveValue('帮我记一下：');
  await expect(page.getByRole('textbox', { name: '输入知识或问题' })).toBeFocused();
  await page.getByRole('textbox', { name: '输入知识或问题' }).fill('尚未发送的草稿');
  await page.getByRole('button', { name: '补充一篇笔记', exact: false }).click();
  await expect(page.getByRole('textbox', { name: '输入知识或问题' })).toHaveValue('尚未发送的草稿');
  await navigation.getByRole('button', { name: '笔记', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: '搜索笔记' })).toBeVisible();
  await navigation.getByRole('button', { name: /变更/ }).click();
  await expect(page.getByRole('complementary', { name: '变更审阅', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入知识或问题' })).toHaveValue('尚未发送的草稿');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('平板审阅占用主内容空间，返回后保留草稿', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '输入知识或问题' });
  await input.fill('平板上的未发送草稿');
  await page.getByRole('button', { name: '展开变更审阅' }).click();
  await expect(page.getByRole('complementary', { name: '变更审阅', exact: true })).toBeVisible();
  await expect(page.getByRole('main')).toBeHidden();
  await page.getByRole('button', { name: '返回主内容' }).click();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('平板上的未发送草稿');
  await expect(page.getByRole('complementary', { name: '变更审阅', exact: true })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
