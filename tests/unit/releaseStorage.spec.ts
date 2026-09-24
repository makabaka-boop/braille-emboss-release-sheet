import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReleaseDraft, issueReleasePermit } from '../../src/lib/release';
import {
  RELEASE_STORAGE_KEY,
  appendReleasePermit,
  loadReleaseStore
} from '../../src/lib/releaseStorage';
import { CalibrationSession } from '../../src/lib/releaseSession';

const PASS = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
const PASS_2 = ['0.65', '0.67', '0.69', '0.71', '0.73', '0.75'];

function makePermit(
  text: string,
  width: number,
  readings: string[],
  id: string,
  issuedAt: number
) {
  const built = buildReleaseDraft(text, width);
  if (!built.ok) {
    throw new Error('夹具单稿不合法');
  }
  const session = new CalibrationSession();
  session.judge(readings, issuedAt - 1000);
  return issueReleasePermit(built.draft, session.getLive(), {
    now: () => issuedAt,
    randomId: () => id
  });
}

function setStored(value: unknown) {
  window.localStorage.setItem(
    RELEASE_STORAGE_KEY,
    typeof value === 'string' ? value : JSON.stringify(value)
  );
}

describe('releaseStorage 不可变放行单存档', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('首次载入为空且无告警', () => {
    const state = loadReleaseStore();
    expect(state.permits).toEqual([]);
    expect(state.warning).toBeNull();
    expect(state.protected).toBe(false);
  });

  it('签发放行单后追加保存，刷新可完整只读恢复', () => {
    const permit = makePermit('12，三。', 4, PASS, 'YF-1', 1_700_000_000_000);
    const result = appendReleasePermit(permit, []);
    expect(result.ok).toBe(true);

    const stored = JSON.parse(window.localStorage.getItem(RELEASE_STORAGE_KEY) ?? '{}');
    expect(stored.version).toBe(1);
    expect(stored.permits).toHaveLength(1);

    const restored = loadReleaseStore();
    expect(restored.warning).toBeNull();
    expect(restored.protected).toBe(false);
    expect(restored.permits).toHaveLength(1);
    expect(restored.permits[0].id).toBe('YF-1');
    expect(restored.permits[0].draft.text).toBe('12，三。');
    expect(restored.permits[0].calibration.readings).toEqual(PASS);
  });

  it('历史单只追加不改写：第二次签发保留两张不同标识的放行单', () => {
    const first = makePermit('12，三。', 4, PASS, 'YF-1', 1_700_000_000_000);
    const second = makePermit('一二三。', 8, PASS_2, 'YF-2', 1_700_000_001_000);

    let result = appendReleasePermit(first, []);
    expect(result.ok).toBe(true);
    result = appendReleasePermit(second, result.permits);
    expect(result.ok).toBe(true);
    expect(result.permits.map((permit) => permit.id)).toEqual(['YF-1', 'YF-2']);

    // 旧单内容不被新草稿覆盖
    const restored = loadReleaseStore();
    expect(restored.permits[0].draft.text).toBe('12，三。');
    expect(restored.permits[0].draft.width).toBe(4);
    expect(restored.permits[1].draft.text).toBe('一二三。');
    expect(restored.permits[1].draft.width).toBe(8);
  });

  it('同标识内容冲突时拒绝写入并保留最近一次完整记录', () => {
    const permit = makePermit('12，三。', 4, PASS, 'YF-1', 1_700_000_000_000);
    appendReleasePermit(permit, []);
    const diskBefore = window.localStorage.getItem(RELEASE_STORAGE_KEY);

    const conflicting = makePermit('一二三。', 4, PASS, 'YF-1', 1_700_000_000_000);
    const result = appendReleasePermit(conflicting, []);
    expect(result.ok).toBe(false);
    expect(result.warning?.kind).toBe('duplicate-id');
    expect(window.localStorage.getItem(RELEASE_STORAGE_KEY)).toBe(diskBefore);
  });

  it('损坏 JSON 时抢救不到记录、明确告警且保护原存档不被刷新写回', () => {
    const broken = '{坏的 JSON';
    setStored(broken);

    const state = loadReleaseStore();
    expect(state.permits).toEqual([]);
    expect(state.warning?.kind).toBe('corrupted-record');
    expect(state.protected).toBe(true);
    expect(state.warning?.message).toContain('合法 JSON');

    // loadReleaseStore 不写回，原损坏字节保留
    expect(window.localStorage.getItem(RELEASE_STORAGE_KEY)).toBe(broken);
  });

  it('列表中部分记录损坏时抢救完整放行单用于只读复核并告警', () => {
    const good = makePermit('12，三。', 4, PASS, 'YF-GOOD', 1_700_000_000_000);
    setStored({
      version: 1,
      permits: [JSON.parse(JSON.stringify(good)), { id: 'YF-BAD' }, 'not-an-object']
    });

    const state = loadReleaseStore();
    expect(state.permits.map((permit) => permit.id)).toEqual(['YF-GOOD']);
    expect(state.warning?.kind).toBe('corrupted-record');
    expect(state.protected).toBe(true);
  });

  it('未知版本不恢复任何放行单并告警保护', () => {
    setStored({ version: 99, permits: [] });
    const state = loadReleaseStore();
    expect(state.permits).toEqual([]);
    expect(state.warning?.kind).toBe('unknown-version');
    expect(state.protected).toBe(true);
  });

  it('单稿快照被篡改或六点复算不合格的记录不被信任', () => {
    const permit = makePermit('12，三。', 4, PASS, 'YF-1', 1_700_000_000_000);

    const tamperedDraft = JSON.parse(JSON.stringify(permit));
    tamperedDraft.draft.text = '一二三。';
    setStored({ version: 1, permits: [tamperedDraft] });
    expect(loadReleaseStore().permits).toEqual([]);

    const tamperedReadings = JSON.parse(JSON.stringify(permit));
    tamperedReadings.calibration.readings = ['0.1', '0.2', '0.3', '0.4', '0.5', '0.6'];
    setStored({ version: 1, permits: [tamperedReadings] });
    expect(loadReleaseStore().permits).toEqual([]);
  });

  it('写入配额失败时返回失败，磁盘原记录不变且内存保留含新单的完整列表', () => {
    const first = makePermit('12，三。', 4, PASS, 'YF-1', 1_700_000_000_000);
    expect(appendReleasePermit(first, []).ok).toBe(true);
    const diskBefore = window.localStorage.getItem(RELEASE_STORAGE_KEY);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    const second = makePermit('一二三。', 4, PASS_2, 'YF-2', 1_700_000_001_000);
    const result = appendReleasePermit(second, [first]);
    expect(result.ok).toBe(false);
    expect(result.warning?.kind).toBe('write-failed');
    expect(result.permits.map((permit) => permit.id)).toEqual(['YF-1', 'YF-2']);
    expect(window.localStorage.getItem(RELEASE_STORAGE_KEY)).toBe(diskBefore);
  });

  it('显式签发新单时连同抢救出的历史单一起重写损坏存档', () => {
    const good = makePermit('12，三。', 4, PASS, 'YF-GOOD', 1_700_000_000_000);
    setStored({ version: 1, permits: [JSON.parse(JSON.stringify(good)), { id: 'BROKEN' }] });

    const damaged = loadReleaseStore();
    expect(damaged.protected).toBe(true);

    const fresh = makePermit('一二三。', 4, PASS_2, 'YF-NEW', 1_700_000_002_000);
    const result = appendReleasePermit(fresh, damaged.permits);
    expect(result.ok).toBe(true);
    expect(result.permits.map((permit) => permit.id)).toEqual(['YF-GOOD', 'YF-NEW']);

    const restored = loadReleaseStore();
    expect(restored.protected).toBe(false);
    expect(restored.warning).toBeNull();
  });
});
