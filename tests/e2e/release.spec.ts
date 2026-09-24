import { expect, test } from '@playwright/test';

const CALIBRATION_KEY = 'braille-plate:calibration:v1';
const RELEASE_KEY = 'braille-plate:release:v1';
const PASS = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

async function fillHeights(page: import('@playwright/test').Page, values: string[]) {
  for (const [index, value] of values.entries()) {
    await page.getByTestId(`height-input-${index + 1}`).fill(value);
  }
}

async function judgeFreshPass(page: import('@playwright/test').Page) {
  await page.getByTestId('mode-calibration').click();
  await fillHeights(page, PASS);
  await page.getByTestId('calibration-judge').click();
  await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
  await page.getByTestId('mode-single').click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('合格签发', () => {
  test('合法单稿 + 本次合格判定后签发放行单，页面展示独立标识与来源快照', async ({ page }) => {
    // 没有判定时按钮不可用并列出阻断原因
    await page.getByTestId('phrase-input').fill('12，三。');
    await page.getByTestId('width-input').fill('4');
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('release-gate-reasons')).toContainText('尚未形成当前有效判定');

    await judgeFreshPass(page);

    await expect(page.getByTestId('release-can-release')).toBeVisible();
    await expect(page.getByTestId('release-issue')).toBeEnabled();
    await page.getByTestId('release-issue').click();

    const current = page.getByTestId('release-current');
    await expect(current).toBeVisible();
    const idText = (await page.getByTestId('release-current-id').innerText()).replace('放行单号：', '');
    expect(idText).toMatch(/^YF-\d{8}-\d{6}-[0-9a-z]{6}$/);

    // 来源快照：原文、行宽、逐方编码、逐行排版、六点读数与合格结论
    await expect(current.getByTestId('permit-text')).toHaveText('12，三。');
    await expect(current.getByTestId('permit-width')).toContainText('每行 4 方');
    const currentCells = current.locator('[data-testid="permit-cells"] .cell');
    await expect(currentCells).toHaveCount(6);
    for (const [index, dots] of ['3456', '1', '12', '2', '14', '256'].entries()) {
      await expect(currentCells.nth(index)).toHaveAttribute('data-dots', dots);
    }
    const lines = current.getByTestId('permit-line');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0).locator('.cell')).toHaveCount(4);
    await expect(lines.nth(1).locator('.cell')).toHaveCount(2);

    const readings = current.locator('[data-testid^="permit-reading-"]');
    await expect(readings).toHaveCount(6);
    await expect(readings.nth(0)).toContainText('0.70');
    await expect(readings.nth(5)).toContainText('0.80');
    await expect(current.getByTestId('permit-conclusion')).toContainText('整机结论：合格');

    // 历史区也能看到同一张只读单
    await expect(page.getByTestId('release-permit')).toHaveCount(1);
    await expect(page.locator('.release-badge-current')).toHaveCount(1);

    // 持久化：刷新后仍是合法历史单
    await page.reload();
    await expect(page.getByTestId('release-permit')).toHaveCount(1);
    await expect(page.getByTestId('release-current')).toHaveCount(0);
    await expect(page.locator('.release-badge-history')).toHaveCount(1);
    await expect(page.getByTestId('release-issue')).toBeDisabled();

    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), RELEASE_KEY);
    expect(stored.version).toBe(1);
    expect(stored.permits).toHaveLength(1);
    expect(stored.permits[0].id).toBe(idText);
  });

  test('非法文字或非法行宽不能签发', async ({ page }) => {
    await judgeFreshPass(page);

    await page.getByTestId('phrase-input').fill('12楼');
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('release-gate-reasons')).toContainText('非法字符');

    await page.getByTestId('phrase-input').fill('12，三。');
    await expect(page.getByTestId('release-issue')).toBeEnabled();

    await page.getByTestId('width-input').fill('21');
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('release-gate-reasons')).toContainText('行宽');
  });

  test('需调机与受阻读数都不能签发', async ({ page }) => {
    await page.getByTestId('phrase-input').fill('12，三。');

    await page.getByTestId('mode-calibration').click();
    await fillHeights(page, ['0.70', '0.71', '0.72', '0.73', '0.74', '0.91']);
    await page.getByTestId('calibration-judge').click();
    await page.getByTestId('mode-single').click();
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('release-gate-reasons')).toContainText('需调机');

    await page.getByTestId('mode-calibration').click();
    await fillHeights(page, ['', 'abc', '0.712', '0', '0.74', '0.75']);
    await page.getByTestId('calibration-judge').click();
    await expect(page.getByTestId('calibration-blocked')).toBeVisible();
    await page.getByTestId('mode-single').click();
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('release-gate-reasons')).toContainText('无效读数');
  });
});

test.describe('改动失效与历史只读', () => {
  test('签发后改文字、改行宽、改任一点读数，当前授权立即失效；历史单不被草稿覆盖', async ({ page }) => {
    await page.getByTestId('phrase-input').fill('12，三。');
    await page.getByTestId('width-input').fill('4');
    await judgeFreshPass(page);
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-current')).toBeVisible();
    const idText = (await page.getByTestId('release-current-id').innerText()).replace('放行单号：', '');

    // 1) 改文字立即失效
    await page.getByTestId('phrase-input').fill('12，三。 ');
    await expect(page.getByTestId('release-invalidated')).toBeVisible();
    await expect(page.getByTestId('release-invalidated-id')).toHaveText(idText);
    await expect(page.getByTestId('release-current')).toHaveCount(0);
    // 历史单里的原文快照保持不变
    await expect(page.getByTestId('release-permit').first().getByTestId('permit-text')).toHaveText('12，三。');

    // 恢复文字后重新成为当前授权
    await page.getByTestId('phrase-input').fill('12，三。');
    await expect(page.getByTestId('release-current')).toBeVisible();

    // 2) 改行宽立即失效
    await page.getByTestId('width-input').fill('8');
    await expect(page.getByTestId('release-invalidated')).toBeVisible();
    await expect(page.getByTestId('release-permit').first().getByTestId('permit-width')).toContainText('每行 4 方');

    // 3) 改任一点读数：原判定先失效，放行随之失效
    await page.getByTestId('mode-calibration').click();
    await page.getByTestId('height-input-3').fill('0.65');
    await page.getByTestId('mode-single').click();
    await expect(page.getByTestId('release-invalidated')).toBeVisible();
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('release-gate-reasons')).toContainText('被改动');

    // 历史单始终只读可复核，且六点读数仍是签发时的快照
    await expect(page.getByTestId('release-permit')).toHaveCount(1);
    const stored = page.getByTestId('release-permit').first();
    await expect(stored.locator('[data-testid="permit-reading-3"]')).toContainText('0.74');
  });
});

test.describe('旧存档不能自动授权', () => {
  test('刷新恢复的旧合格校准只展示历史结论，必须重新判定才能放行', async ({ page }) => {
    await page.getByTestId('phrase-input').fill('12，三。');
    await judgeFreshPass(page);

    await page.reload();
    await page.getByTestId('mode-calibration').click();
    // 恢复出的合格结论只在校准工作区展示
    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
    await page.getByTestId('mode-single').click();
    // 放行侧明确要求重新判定，按钮不可用
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('release-gate-reasons')).toContainText('恢复的存档');

    // 重新执行判定后获得当前授权
    await page.getByTestId('mode-calibration').click();
    await page.getByTestId('calibration-judge').click();
    await page.getByTestId('mode-single').click();
    await expect(page.getByTestId('release-issue')).toBeEnabled();
  });

  test('损坏的放行单存档明确告警并抢救完整历史单，不自动覆盖', async ({ page }) => {
    // 先签发一张合法单
    await page.getByTestId('phrase-input').fill('12，三。');
    await judgeFreshPass(page);
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-permit')).toHaveCount(1);

    // 再向存档塞入损坏内容
    await page.evaluate((key) => {
      const raw = localStorage.getItem(key) ?? '{"version":1,"permits":[]}';
      const parsed = JSON.parse(raw) as { permits: unknown[] };
      parsed.permits.push({ id: 'BROKEN' });
      localStorage.setItem(key, JSON.stringify(parsed));
    }, RELEASE_KEY);
    await page.reload();

    await expect(page.getByTestId('release-archive-warning')).toContainText('无法通过校验');
    // 完整的那张仍可只读复核
    await expect(page.getByTestId('release-permit')).toHaveCount(1);
    await expect(page.getByTestId('release-current')).toHaveCount(0);

    // 告警期间不会因刷新或操作自动写回损坏状态：重新判定并签发新单才重写
    await page.reload();
    await expect(page.getByTestId('release-archive-warning')).toBeVisible();
  });
});

test.describe('跨标签页更新', () => {
  test('另一标签页的合格校准不会自动成为本标签页授权；放行单新增在本标签页只读可见', async ({
    browser
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto('/');
    await pageB.goto('/');

    await pageA.getByTestId('phrase-input').fill('12，三。');
    await pageA.getByTestId('width-input').fill('4');

    // 标签页 B 完成一次合格判定（写入 localStorage 并广播 storage 事件）
    await pageB.getByTestId('mode-calibration').click();
    await fillHeights(pageB, PASS);
    await pageB.getByTestId('calibration-judge').click();
    await expect(pageB.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');

    // 标签页 A 收到跨标签更新：只能恢复历史展示，不能自动授权
    await expect(pageA.getByTestId('release-gate-reasons')).toContainText('恢复的存档');
    await expect(pageA.getByTestId('release-issue')).toBeDisabled();
    // 校准工作区同样只展示恢复出的历史结论
    await pageA.getByTestId('mode-calibration').click();
    await expect(pageA.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
    await pageA.getByTestId('mode-single').click();
    await expect(pageA.getByTestId('release-issue')).toBeDisabled();

    // B 回到单稿模式签发放行单（其本会话判定不受 A 的存储事件影响）
    await pageB.getByTestId('mode-single').click();
    await pageB.getByTestId('phrase-input').fill('12，三。');
    await pageB.getByTestId('width-input').fill('4');
    await expect(pageB.getByTestId('release-issue')).toBeEnabled();
    await pageB.getByTestId('release-issue').click();
    await expect(pageA.getByTestId('release-permit')).toHaveCount(1);
    await expect(pageA.getByTestId('release-current')).toHaveCount(0);
    await expect(pageA.getByTestId('release-issue')).toBeDisabled();

    await context.close();
  });

  test('本标签页完成合格判定后，其它标签页的旧校准更新不能撤销当前授权', async ({ browser }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await pageA.goto('/');
    await pageB.goto('/');

    // A 完成合格判定并签发
    await pageA.getByTestId('phrase-input').fill('12，三。');
    await pageA.getByTestId('width-input').fill('4');
    await pageA.getByTestId('mode-calibration').click();
    await fillHeights(pageA, PASS);
    await pageA.getByTestId('calibration-judge').click();
    await pageA.getByTestId('mode-single').click();
    await pageA.getByTestId('release-issue').click();
    await expect(pageA.getByTestId('release-current')).toBeVisible();

    // B 刷新后持有的是旧合格存档，B 上再触发一次草稿写盘（清空重填后恢复旧快照）
    await pageB.getByTestId('mode-calibration').click();
    await expect(pageB.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');

    // A 的当前授权不被 B 的任何存储事件撤销
    await expect(pageA.getByTestId('release-current')).toBeVisible();

    await context.close();
  });
});

test.describe('失败保护', () => {
  test('放行单写入失败时明确告警，内存保留新单只读复核，磁盘记录不变', async ({ page }) => {
    await page.getByTestId('phrase-input').fill('12，三。');
    await judgeFreshPass(page);

    await page.evaluate(() => {
      Object.defineProperty(window.localStorage, 'setItem', {
        configurable: true,
        value: () => {
          throw new DOMException('quota exceeded', 'QuotaExceededError');
        }
      });
    });

    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-storage-error')).toContainText('写入失败');
    // 当前授权仍在本会话（新判定未被改动），新单在历史区可只读复核
    await expect(page.getByTestId('release-current')).toBeVisible();
    await expect(page.getByTestId('release-permit')).toHaveCount(1);

    // 磁盘上没有放行单记录
    const stored = await page.evaluate((key) => localStorage.getItem(key), RELEASE_KEY);
    expect(stored).toBeNull();

    // 恢复浏览器原生 setItem（此前覆写在 localStorage 实例自身上），
    // 再刷新：内存态消失且不出现伪造授权
    await page.evaluate(() => {
      delete (window.localStorage as { setItem?: unknown }).setItem;
    });
    await page.reload();
    await expect(page.getByTestId('release-permit')).toHaveCount(0);
    await expect(page.getByTestId('release-current')).toHaveCount(0);
  });

  test('校准存档损坏时放行侧不显示结论并要求重新判定，原校准存档不被覆盖', async ({ page }) => {
    await page.evaluate(
      ([key]) => localStorage.setItem(key, '{损坏'),
      [CALIBRATION_KEY] as [string]
    );
    await page.goto('/');
    await page.getByTestId('phrase-input').fill('12，三。');

    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('release-gate-reasons')).toContainText('尚未形成当前有效判定');

    await page.getByTestId('mode-calibration').click();
    await expect(page.getByTestId('calibration-archive-warning')).toContainText('损坏');
    const raw = await page.evaluate((key) => localStorage.getItem(key), CALIBRATION_KEY);
    expect(raw).toBe('{损坏');
  });
});
