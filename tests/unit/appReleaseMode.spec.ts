import { createApp, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../../src/App.vue';
import { RELEASE_STORAGE_KEY } from '../../src/lib/releaseStorage';
import { CALIBRATION_STORAGE_KEY } from '../../src/lib/calibrationStorage';

/**
 * 直接挂载真实 App，覆盖放行闸门与单稿预检、试压校准工作区之间的联动：
 * 合格签发、改动失效、刷新恢复旧存档不自动授权。
 */
function mountApp() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = createApp(App);
  app.mount(container);
  return {
    container,
    unmount() {
      app.unmount();
      container.remove();
    }
  };
}

function $(selector: string): HTMLElement | null {
  return document.querySelector(selector);
}

function $$(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll(selector));
}

async function tick() {
  await nextTick();
  await Promise.resolve();
}

async function click(testid: string) {
  ($(`[data-testid="${testid}"]`) as HTMLButtonElement).click();
  await tick();
}

async function fill(testid: string, value: string) {
  const input = $(`[data-testid="${testid}"]`) as HTMLInputElement | HTMLTextAreaElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
}

async function fillHeights(values: string[]) {
  for (const [index, value] of values.entries()) {
    await fill(`height-input-${index + 1}`, value);
  }
}

const PASS = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

describe('App 压点放行联动', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
  });

  it('合法单稿但未判定时不能放行；本次合格判定后可签发，放行单展示来源快照', async () => {
    const app = mountApp();

    await fill('phrase-input', '12，三。');
    await fill('width-input', '4');

    const issue = $('[data-testid="release-issue"]') as HTMLButtonElement;
    expect(issue.disabled).toBe(true);
    expect($$('[data-testid="release-gate-reason"]').map((node) => node.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('尚未形成当前有效判定')])
    );

    await click('mode-calibration');
    await fillHeights(PASS);
    await click('calibration-judge');
    await click('mode-single');

    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(false);
    expect($('[data-testid="release-can-release"]')).not.toBeNull();

    await click('release-issue');
    const current = $('[data-testid="release-current"]') as HTMLElement;
    expect(current).not.toBeNull();
    expect(current.querySelector('[data-testid="release-current-id"]')?.textContent).toMatch(/YF-/);
    expect(current.querySelector('[data-testid="permit-text"]')?.textContent).toBe('12，三。');
    expect(current.querySelector('[data-testid="permit-width"]')?.textContent).toContain('4');
    expect(current.querySelectorAll('[data-testid^="permit-reading-"]')).toHaveLength(6);
    expect(current.querySelectorAll('[data-testid="permit-reading-1"] td')[2]?.textContent).toContain('0.70');
    expect(current.querySelectorAll('[data-testid="permit-line"]')).toHaveLength(2);

    const stored = JSON.parse(window.localStorage.getItem(RELEASE_STORAGE_KEY) ?? '{}');
    expect(stored.version).toBe(1);
    expect(stored.permits).toHaveLength(1);

    app.unmount();
  });

  it('需调机不能签发', async () => {
    const app = mountApp();
    await click('mode-calibration');
    await fillHeights(['0.70', '0.71', '0.72', '0.73', '0.74', '0.91']);
    await click('calibration-judge');
    await click('mode-single');
    await fill('phrase-input', '12，三。');

    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);
    expect($$('[data-testid="release-gate-reason"]').map((node) => node.textContent).join('')).toContain('需调机');
    app.unmount();
  });

  it('签发后修改文字或行宽，当前授权立即失效；历史单仍只读可见且内容不变', async () => {
    const app = mountApp();
    await fill('phrase-input', '12，三。');
    await click('mode-calibration');
    await fillHeights(PASS);
    await click('calibration-judge');
    await click('mode-single');
    await click('release-issue');
    const issuedId = $('[data-testid="release-current-id"]')?.textContent ?? '';

    await fill('phrase-input', '12，三。 ');
    expect($('[data-testid="release-invalidated"]')).not.toBeNull();
    expect($('[data-testid="release-current"]')).toBeNull();
    const historyAfterText = $$('[data-testid="release-permit"]');
    expect(historyAfterText).toHaveLength(1);
    expect($('[data-testid="permit-text"]')?.textContent).toBe('12，三。');

    // 改回原文，再改行宽同样失效
    await fill('phrase-input', '12，三。');
    expect($('[data-testid="release-current"]')).not.toBeNull();
    await fill('width-input', '8');
    expect($('[data-testid="release-invalidated"]')).not.toBeNull();
    expect($('[data-testid="release-invalidated-id"]')?.textContent).toBe(issuedId.replace('放行单号：', ''));

    app.unmount();
  });

  it('刷新恢复的旧合格存档不能自动授权，必须重新判定', async () => {
    window.localStorage.setItem(
      CALIBRATION_STORAGE_KEY,
      JSON.stringify({ version: 2, draft: { readings: PASS }, judgedRaws: PASS })
    );

    const app = mountApp();
    await fill('phrase-input', '12，三。');
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);
    expect($$('[data-testid="release-gate-reason"]').map((node) => node.textContent).join('')).toContain(
      '恢复的存档'
    );

    // 进入校准工作区看到历史合格结论，但放行侧仍是恢复态
    await click('mode-calibration');
    expect($('[data-testid="calibration-result"]')?.getAttribute('data-verdict')).toBe('pass');
    await click('mode-single');
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);

    // 重新执行一次判定后才放行
    await click('mode-calibration');
    await click('calibration-judge');
    await click('mode-single');
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(false);

    app.unmount();
  });

  it('旧放行单刷新后作为只读历史展示，不被视为当前授权', async () => {
    // 直接预置一张合法放行单存档（通过存储层完整校验的形态）
    const draft = {
      text: '12，三。',
      width: 4,
      cells: ['3456', '1', '12', '2', '14', '256'],
      lines: [['3456', '1', '12', '2'], ['14', '256']],
      totalCells: 6
    };
    const values = [0.7, 0.72, 0.74, 0.76, 0.78, 0.8];
    const permit = {
      id: 'YF-OLD-0001',
      issuedAt: 1_700_000_000_000,
      draft,
      calibration: {
        verdict: 'pass',
        readings: PASS,
        values,
        points: [],
        threshold: { min: 0.7, max: 0.8, spread: 0.1, spreadLimit: 0.15, spreadOk: true, rangeMin: 0.6, rangeMax: 0.9 },
        conclusion:
          '整机结论：合格。六点凸点高度均在 0.60–0.90 毫米内，极差 0.10 毫米（限值 0.15 毫米），可以投入铭牌压点生产。',
        judgedAt: 1_699_999_999_000
      }
    };
    window.localStorage.setItem(RELEASE_STORAGE_KEY, JSON.stringify({ version: 1, permits: [permit] }));

    const app = mountApp();
    await fill('phrase-input', '12，三。');
    await fill('width-input', '4');

    // 没有本会话判定：历史单只读可见，但不是当前授权，也不能再签发
    const cards = $$('[data-testid="release-permit"]');
    expect(cards).toHaveLength(1);
    expect($('[data-testid="release-current"]')).toBeNull();
    expect($$('.release-badge-history')).toHaveLength(1);
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);

    app.unmount();
  });

  it('跨标签页收到合格校准更新只恢复历史展示，不自动授权', async () => {
    const app = mountApp();
    await fill('phrase-input', '12，三。');
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);

    window.localStorage.setItem(
      CALIBRATION_STORAGE_KEY,
      JSON.stringify({ version: 2, draft: { readings: PASS }, judgedRaws: PASS })
    );
    window.dispatchEvent(
      new StorageEvent('storage', { key: CALIBRATION_STORAGE_KEY, storageArea: window.localStorage })
    );
    await tick();

    expect($$('[data-testid="release-gate-reason"]').map((node) => node.textContent).join('')).toContain(
      '恢复的存档'
    );
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);

    // 跨标签页的损坏存档同样不能给出授权
    window.localStorage.setItem(CALIBRATION_STORAGE_KEY, '{坏');
    window.dispatchEvent(
      new StorageEvent('storage', { key: CALIBRATION_STORAGE_KEY, storageArea: window.localStorage })
    );
    await tick();
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);

    app.unmount();
  });

  it('跨标签页新增放行单后本页只读可见；本页当前授权不被旧校准更新撤销', async () => {    const app = mountApp();
    await fill('phrase-input', '12，三。');
    await fill('width-input', '4');
    await click('mode-calibration');
    await fillHeights(PASS);
    await click('calibration-judge');
    await click('mode-single');
    await click('release-issue');
    const firstId = $('[data-testid="release-current-id"]')?.textContent ?? '';
    expect(firstId).not.toBe('');

    // 另一标签页写入一张新的合法放行单（存储层可复算的形态）
    const second = {
      id: 'YF-CROSSTAB-0002',
      issuedAt: 1_700_000_002_000,
      draft: {
        text: '一二三。',
        width: 8,
        cells: ['1', '12', '14', '256'],
        lines: [['1', '12', '14', '256']],
        totalCells: 4
      },
      calibration: {
        verdict: 'pass',
        readings: ['0.65', '0.67', '0.69', '0.71', '0.73', '0.75'],
        values: [0.65, 0.67, 0.69, 0.71, 0.73, 0.75],
        points: [],
        threshold: { min: 0.65, max: 0.75, spread: 0.1, spreadLimit: 0.15, spreadOk: true, rangeMin: 0.6, rangeMax: 0.9 },
        conclusion:
          '整机结论：合格。六点凸点高度均在 0.60–0.90 毫米内，极差 0.10 毫米（限值 0.15 毫米），可以投入铭牌压点生产。',
        judgedAt: 1_700_000_001_000
      }
    };
    const raw = JSON.parse(window.localStorage.getItem(RELEASE_STORAGE_KEY) ?? '{"version":1,"permits":[]}');
    raw.permits.push(second);
    window.localStorage.setItem(RELEASE_STORAGE_KEY, JSON.stringify(raw));
    window.dispatchEvent(
      new StorageEvent('storage', { key: RELEASE_STORAGE_KEY, storageArea: window.localStorage })
    );
    await tick();

    const cards = $$('[data-testid="release-permit"]');
    expect(cards).toHaveLength(2);
    // 当前授权仍是本页签发的第一张
    expect($('[data-testid="release-current-id"]')?.textContent).toBe(firstId);

    // 另一标签页的旧合格校准广播不会撤销当前授权（放行闸门只认本页会话）
    window.localStorage.setItem(
      CALIBRATION_STORAGE_KEY,
      JSON.stringify({ version: 2, draft: { readings: PASS }, judgedRaws: PASS })
    );
    window.dispatchEvent(
      new StorageEvent('storage', { key: CALIBRATION_STORAGE_KEY, storageArea: window.localStorage })
    );
    await tick();
    expect($('[data-testid="release-current"]')).not.toBeNull();
    expect($('[data-testid="release-current-id"]')?.textContent).toBe(firstId);

    app.unmount();
  });
});
