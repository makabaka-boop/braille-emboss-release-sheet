import { describe, expect, it } from 'vitest';
import { CalibrationSession } from '../../src/lib/releaseSession';

const PASS = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
const ADJUST = ['0.70', '0.71', '0.72', '0.73', '0.74', '0.91'];
const BLOCKED = ['', 'abc', '0.74', '0.76', '0.78', '0.80'];

describe('CalibrationSession 新判定与存档恢复的区分', () => {
  it('本会话执行的合格判定为 fresh pass，可放行；需调机不是', () => {
    const session = new CalibrationSession();
    let result = session.judge(PASS, 1000);
    expect(result.verdict).toBe('pass');
    expect(session.isFreshPass).toBe(true);
    expect(session.getLive().status).toBe('pass');
    expect(session.judgedReadings).toEqual(PASS);

    const adjustSession = new CalibrationSession();
    adjustSession.judge(ADJUST, 1000);
    expect(adjustSession.isFreshPass).toBe(false);
    expect(adjustSession.getLive().status).toBe('adjust');
  });

  it('受阻读数不形成判定快照', () => {
    const session = new CalibrationSession();
    const result = session.judge(BLOCKED);
    expect(result.verdict).toBe('blocked');
    expect(session.getLive().status).toBe('blocked');
    expect(session.judgedReadings).toBeNull();
    expect(session.isFreshPass).toBe(false);
  });

  it('刷新恢复的合格结论只能是 restored-pass，不能自动授权', () => {
    const session = new CalibrationSession();
    session.restore({ judgedAt: 500, readings: PASS }, 'load');
    expect(session.getLive().status).toBe('restored-pass');
    expect(session.isFreshPass).toBe(false);
    expect(session.lastRestoreSource).toBe('load');
    expect(session.judgedReadings).toEqual(PASS);
  });

  it('跨标签页恢复标注 storage-event，需调机恢复为 restored-adjust', () => {
    const session = new CalibrationSession();
    session.restore({ judgedAt: 500, readings: ADJUST }, 'storage-event');
    expect(session.getLive().status).toBe('restored-adjust');
    expect(session.lastRestoreSource).toBe('storage-event');
    expect(session.isFreshPass).toBe(false);
  });

  it('恢复后重新执行判定即升级为当前授权', () => {
    const session = new CalibrationSession();
    session.restore({ judgedAt: 500, readings: PASS });
    session.judge(PASS, 2000);
    expect(session.getLive().status).toBe('pass');
    expect(session.isFreshPass).toBe(true);
  });

  it('判定之后任一读数被改动，结论立即失效（含恢复结论）', () => {
    const session = new CalibrationSession();
    session.judge(PASS);
    session.editReadings(['0.65', ...PASS.slice(1)]);
    expect(session.getLive().status).toBe('drafting');
    expect(session.isFreshPass).toBe(false);

    const restored = new CalibrationSession();
    restored.restore({ judgedAt: 1, readings: PASS });
    restored.editReadings(['0.65', ...PASS.slice(1)]);
    expect(restored.getLive().status).toBe('drafting');
  });

  it('恢复损坏记录回到 idle / blocked，不携带可放行状态', () => {
    const session = new CalibrationSession();
    session.judge(PASS);
    session.reset();
    expect(session.getLive().status).toBe('idle');

    const blockedSession = new CalibrationSession();
    blockedSession.restore({ judgedAt: 0, readings: BLOCKED });
    expect(blockedSession.getLive().status).toBe('blocked');
  });
});
