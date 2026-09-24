import { describe, expect, it } from 'vitest';
import {
  buildReleaseDraft,
  evaluateGate,
  isPermitCurrent,
  issueReleasePermit,
  type LiveCalibration
} from '../../src/lib/release';
import { CalibrationSession } from '../../src/lib/releaseSession';

const PASS_READINGS = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
const ADJUST_READINGS = ['0.70', '0.71', '0.72', '0.73', '0.74', '0.91'];
const BLOCKED_READINGS = ['', 'abc', '0.74', '0.76', '0.78', '0.80'];

function freshPass(now = 1_700_000_000_000): LiveCalibration {
  const session = new CalibrationSession();
  session.judge(PASS_READINGS, now);
  return session.getLive();
}

describe('buildReleaseDraft 单稿快照', () => {
  it('合法单稿固化原文、行宽、逐方编码与逐行排版', () => {
    const built = buildReleaseDraft('12，三。', 4);
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    expect(built.draft.text).toBe('12，三。');
    expect(built.draft.width).toBe(4);
    expect(built.draft.cells).toEqual(['3456', '1', '12', '2', '14', '256']);
    expect(built.draft.lines).toEqual([
      ['3456', '1', '12', '2'],
      ['14', '256']
    ]);
    expect(built.draft.totalCells).toBe(6);
  });

  it('空文本、非法字符与非法行宽都不能形成快照', () => {
    const empty = buildReleaseDraft('', 12);
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.reasons).toContain('empty-text');
    }

    const illegal = buildReleaseDraft('12楼', 12);
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) {
      expect(illegal.reasons).toContain('illegal-character');
    }

    const badWidth = buildReleaseDraft('一二三', 21);
    expect(badWidth.ok).toBe(false);
    if (!badWidth.ok) {
      expect(badWidth.reasons).toContain('illegal-width');
    }
  });

  it('非法字符与行宽问题同时报告', () => {
    const built = buildReleaseDraft('A', 3);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.reasons).toEqual(['illegal-character', 'illegal-width']);
    }
  });
});

describe('evaluateGate 放行闸门', () => {
  it('合法单稿 + 本次新完成的合格判定才可放行', () => {
    const gate = evaluateGate('12，三。', 4, freshPass());
    expect(gate.releasable).toBe(true);
    expect(gate.reasons).toEqual([]);
    expect(gate.draft?.text).toBe('12，三。');
  });

  it('需调机不能放行', () => {
    const session = new CalibrationSession();
    session.judge(ADJUST_READINGS);
    const gate = evaluateGate('12，三。', 4, session.getLive());
    expect(gate.releasable).toBe(false);
    expect(gate.reasons).toEqual(['verdict-adjust']);
    expect(gate.messages.join('')).toContain('需调机');
  });

  it('受阻读数不能放行', () => {
    const session = new CalibrationSession();
    session.judge(BLOCKED_READINGS);
    const gate = evaluateGate('12，三。', 4, session.getLive());
    expect(gate.releasable).toBe(false);
    expect(gate.reasons).toEqual(['readings-blocked']);
  });

  it('未判定或判定后又改动读数（drafting）不能放行', () => {
    expect(evaluateGate('12，三。', 4, { status: 'idle' }).reasons).toEqual(['no-judgment']);

    const session = new CalibrationSession();
    session.judge(PASS_READINGS);
    session.editReadings(PASS_READINGS.map((value, index) => (index === 0 ? '0.65' : value)));
    const gate = evaluateGate('12，三。', 4, session.getLive());
    expect(gate.releasable).toBe(false);
    expect(gate.reasons).toEqual(['no-judgment']);
    expect(gate.messages[0]).toContain('被改动');
  });

  it('存档恢复的旧“合格”判定不能自动当作当前授权', () => {
    const session = new CalibrationSession();
    session.restore({ judgedAt: 1, readings: PASS_READINGS }, 'load');
    const gate = evaluateGate('12，三。', 4, session.getLive());
    expect(gate.releasable).toBe(false);
    expect(gate.reasons).toEqual(['restored-archive']);
    expect(gate.messages.join('')).toContain('重新执行');
  });

  it('非法文字时即使校准合格也不能放行', () => {
    const gate = evaluateGate('12楼', 4, freshPass());
    expect(gate.releasable).toBe(false);
    expect(gate.draft).toBeNull();
    expect(gate.reasons).toContain('illegal-character');
  });
});

describe('issueReleasePermit 不可变放行单', () => {
  function issue(text = '12，三。', width: string | number = 4) {
    const draft = buildReleaseDraft(text, width);
    if (!draft.ok) {
      throw new Error('夹具单稿不合法');
    }
    return issueReleasePermit(draft.draft, freshPass(), {
      now: () => 1_700_000_123_456,
      randomId: () => 'YF-TEST-0001'
    });
  }

  it('放行单有独立标识，并固化来源快照', () => {
    const permit = issue();
    expect(permit.id).toBe('YF-TEST-0001');
    expect(permit.issuedAt).toBe(1_700_000_123_456);
    expect(permit.draft.text).toBe('12，三。');
    expect(permit.draft.width).toBe(4);
    expect(permit.draft.cells).toEqual(['3456', '1', '12', '2', '14', '256']);
    expect(permit.draft.lines).toHaveLength(2);
    expect(permit.calibration.verdict).toBe('pass');
    expect(permit.calibration.readings).toEqual(PASS_READINGS);
    expect(permit.calibration.values).toEqual([0.7, 0.72, 0.74, 0.76, 0.78, 0.8]);
  });

  it('放行单整体不可变', () => {
    const permit = issue();
    expect(Object.isFrozen(permit)).toBe(true);
    expect(Object.isFrozen(permit.draft)).toBe(true);
    expect(Object.isFrozen(permit.draft.lines)).toBe(true);
    expect(Object.isFrozen(permit.calibration)).toBe(true);
    expect(Object.isFrozen(permit.calibration.readings)).toBe(true);
    expect(() => {
      (permit as unknown as { id: string }).id = 'OTHER';
    }).toThrow();
  });

  it('需调机、受阻或存档恢复状态一律拒绝签发', () => {
    const draft = buildReleaseDraft('12，三。', 4);
    if (!draft.ok) {
      throw new Error('夹具单稿不合法');
    }

    const adjustSession = new CalibrationSession();
    adjustSession.judge(ADJUST_READINGS);
    expect(() => issueReleasePermit(draft.draft, adjustSession.getLive())).toThrow(TypeError);

    expect(() => issueReleasePermit(draft.draft, { status: 'idle' })).toThrow(TypeError);

    const restored = new CalibrationSession();
    restored.restore({ judgedAt: 1, readings: PASS_READINGS });
    expect(() => issueReleasePermit(draft.draft, restored.getLive())).toThrow(TypeError);
  });

  it('被篡改的单稿快照（与重新复算不一致）拒绝签发', () => {
    const built = buildReleaseDraft('12，三。', 4);
    if (!built.ok) {
      throw new Error('夹具单稿不合法');
    }
    const tampered = { ...built.draft, text: '一二三。' };
    expect(() => issueReleasePermit(tampered, freshPass())).toThrow(TypeError);
  });
});

describe('isPermitCurrent 改动失效', () => {
  function permit() {
    const draft = buildReleaseDraft('12，三。', 4);
    if (!draft.ok) {
      throw new Error('夹具单稿不合法');
    }
    return issueReleasePermit(draft.draft, freshPass(1_700_000_000_000));
  }

  it('原文、行宽与读数一致时保持当前授权', () => {
    const session = new CalibrationSession();
    session.judge(PASS_READINGS, 1_700_000_000_000);
    expect(isPermitCurrent(permit(), '12，三。', 4, session.getLive())).toBe(true);
  });

  it('修改文字立即失效', () => {
    expect(isPermitCurrent(permit(), '12，三。 ', 4, freshPass())).toBe(false);
  });

  it('修改行宽立即失效', () => {
    expect(isPermitCurrent(permit(), '12，三。', 8, freshPass())).toBe(false);
  });

  it('修改任一点读数立即失效', () => {
    const session = new CalibrationSession();
    session.judge(['0.70', '0.72', '0.65', '0.76', '0.78', '0.80']);
    expect(isPermitCurrent(permit(), '12，三。', 4, session.getLive())).toBe(false);
  });

  it('当前判定退为需调机或恢复态时失效', () => {
    const adjust = new CalibrationSession();
    adjust.judge(ADJUST_READINGS);
    expect(isPermitCurrent(permit(), '12，三。', 4, adjust.getLive())).toBe(false);

    const restored = new CalibrationSession();
    restored.restore({ judgedAt: 1, readings: PASS_READINGS });
    expect(isPermitCurrent(permit(), '12，三。', 4, restored.getLive())).toBe(false);
  });

  it('屏幕内容变成非法单稿时失效，但放行单对象本身不被改动', () => {
    const stored = permit();
    expect(isPermitCurrent(stored, '12楼', 4, freshPass())).toBe(false);
    expect(stored.draft.text).toBe('12，三。');
  });
});
