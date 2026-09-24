import { createApp, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReleasePanel from '../../src/components/ReleasePanel.vue';
import { CalibrationSession } from '../../src/lib/releaseSession';
import { RELEASE_STORAGE_KEY } from '../../src/lib/releaseStorage';

function mountPanel(props: { text: string; width: number; live: ReturnType<CalibrationSession['getLive']> }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = createApp(ReleasePanel, props);
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

async function click(testid: string) {
  ($(`[data-testid="${testid}"]`) as HTMLButtonElement).click();
  await nextTick();
}

const PASS = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
const PASS_2 = ['0.65', '0.67', '0.69', '0.71', '0.73', '0.75'];

function freshLive(readings = PASS): ReturnType<CalibrationSession['getLive']> {
  const session = new CalibrationSession();
  session.judge(readings, 1_700_000_000_000);
  return session.getLive();
}

/** 与存储层校验形态一致的合法放行单夹具。 */
function storedPermit(id: string, issuedAt: number, text: string, width: number, readings: string[]) {
  const cells =
    text === '12，三。'
      ? ['3456', '1', '12', '2', '14', '256']
      : ['1', '12', '14', '256'];
  const lines =
    width === 4
      ? [cells.slice(0, 4), cells.slice(4)]
      : [cells];
  const values = readings.map(Number);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    id,
    issuedAt,
    draft: { text, width, cells, lines, totalCells: cells.length },
    calibration: {
      verdict: 'pass' as const,
      readings,
      values,
      points: [],
      threshold: { min, max, spread: Math.round((max - min) * 100) / 100, spreadLimit: 0.15, spreadOk: true, rangeMin: 0.6, rangeMax: 0.9 },
      conclusion:
        '整机结论：合格。六点凸点高度均在 0.60–0.90 毫米内，极差 0.10 毫米（限值 0.15 毫米），可以投入铭牌压点生产。',
      judgedAt: issuedAt - 1000
    }
  };
}

describe('ReleasePanel 存档异常与跨标签合并', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
  });

  it('损坏存档告警并展示抢救出的历史单；重新签发后告警消除且历史单保留', async () => {
    window.localStorage.setItem(
      RELEASE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        permits: [storedPermit('YF-OLD', 1_700_000_000_000, '12，三。', 4, PASS), { id: 'BROKEN' }]
      })
    );

    const mounted = mountPanel({ text: '12，三。', width: 4, live: freshLive() });

    expect($('[data-testid="release-archive-warning"]')?.textContent).toContain('无法通过校验');
    expect(document.querySelectorAll('[data-testid="release-permit"]')).toHaveLength(1);
    expect($('[data-testid="release-permit-id"]')?.textContent).toBe('YF-OLD');

    await click('release-issue');
    expect($('[data-testid="release-archive-warning"]')).toBeNull();
    const cards = document.querySelectorAll('[data-testid="release-permit"]');
    expect(cards).toHaveLength(2);

    // 磁盘被重写为两条完整记录（抢救出的旧单 + 新签发单）
    const stored = JSON.parse(window.localStorage.getItem(RELEASE_STORAGE_KEY) ?? '{}');
    const ids = stored.permits.map((permit: { id: string }) => permit.id);
    expect(ids).toContain('YF-OLD');
    expect(ids).toHaveLength(2);

    mounted.unmount();
  });

  it('写入失败时保留内存新单并明确告警', async () => {
    const mounted = mountPanel({ text: '12，三。', width: 4, live: freshLive() });

    // 先拿到原型上的原生 setItem，再安装只拦截放行单键的 spy
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === RELEASE_STORAGE_KEY) {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    });

    await click('release-issue');
    expect($('[data-testid="release-storage-error"]')?.textContent).toContain('写入失败');
    expect(document.querySelectorAll('[data-testid="release-permit"]')).toHaveLength(1);
    expect($('[data-testid="release-current"]')).not.toBeNull();
    expect(window.localStorage.getItem(RELEASE_STORAGE_KEY)).toBeNull();

    Storage.prototype.setItem = nativeSetItem;
    mounted.unmount();
  });

  it('跨标签页新增放行单实时出现在历史区，不抢占当前授权', async () => {
    const mounted = mountPanel({ text: '12，三。', width: 4, live: freshLive() });
    await click('release-issue');
    const firstId = $('[data-testid="release-current-id"]')?.textContent ?? '';
    expect(firstId).not.toBe('');

    window.localStorage.setItem(
      RELEASE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        permits: [storedPermit(firstId.replace('放行单号：', ''), 1_700_000_000_000, '12，三。', 4, PASS), storedPermit('YF-OTHER', 1_700_000_002_000, '一二三。', 8, PASS_2)]
      })
    );
    window.dispatchEvent(
      new StorageEvent('storage', { key: RELEASE_STORAGE_KEY, storageArea: window.localStorage })
    );
    await nextTick();

    // 另一标签页重写了与本页同内容的第一张单：按同标识去重，不产生重复卡片
    const cards = document.querySelectorAll('[data-testid="release-permit"]');
    expect(cards).toHaveLength(2);
    expect($('[data-testid="release-current-id"]')?.textContent).toBe(firstId);

    mounted.unmount();
  });
});
