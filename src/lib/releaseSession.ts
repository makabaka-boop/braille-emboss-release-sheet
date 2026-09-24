/**
 * 放行流程的会话状态机（纯内存，不接触存储）。
 *
 * 校准工作区既有的“成功判定即落盘、刷新可恢复”行为保持不变；放行流程需要
 * 额外区分一次判定是**本次新完成**的，还是从本地存档（刷新 / 跨标签页）
 * 恢复的。本模块只维护这层会话状态与单稿输入指纹，供单稿预检工作区决定
 * “当前是否可放行 / 已签发的放行单是否仍为当前授权”。
 *
 * 状态来源约定：
 *  - judge：用户在本会话点击“执行判定”，合格 / 需调机都是新判定；
 *  - restore：刷新或收到跨标签页存储事件后恢复，一律标注为存档恢复，
 *    即使内容是“合格”，也不能自动当作当前授权，必须重新判定；
 *  - editReadings：任一读数被改动，判定立即失效，进入 drafting；
 *  - 受阻读数只保留 blocked 状态，不形成判定快照。
 */
import {
  judgeCalibration,
  type CalibrationResult
} from './calibration';
import {
  snapshotFromResult,
  type CalibrationSnapshotView,
  type LiveCalibration
} from './release';

export type CalibrationLiveState = LiveCalibration;

/** 从存档恢复时的来源，用于跨标签页提示。 */
export type RestoreSource = 'load' | 'storage-event';

/** 一次成功判定（合格 / 需调机）落盘的完整快照契约（校准存储 v2 同形）。 */
export interface CalibrationRecord {
  judgedAt: number;
  readings: string[];
}

/**
 * 校准会话状态：额外记录恢复来源，以及当前判定所用六点读数
 * （供“修改读数即失效”比对，恢复时同样从存档重建）。
 */
export class CalibrationSession {
  private state: LiveCalibration = { status: 'idle' };
  private restoreSource: RestoreSource = 'load';

  getLive(): LiveCalibration {
    return this.state;
  }

  /** 当前判定（本次新判定或存档恢复）的六点读数；没有完整判定时为 null。 */
  get judgedReadings(): string[] | null {
    switch (this.state.status) {
      case 'pass':
      case 'adjust':
      case 'restored-pass':
      case 'restored-adjust':
        return this.state.snapshot.readings.slice();
      default:
        return null;
    }
  }

  /** 是否为本次新完成的合格判定（放行唯一认可的来源）。 */
  get isFreshPass(): boolean {
    return this.state.status === 'pass';
  }

  get lastRestoreSource(): RestoreSource {
    return this.restoreSource;
  }

  /**
   * 用户在本会话执行一次判定。
   * 读数全部有效时形成新判定（合格 / 需调机）；受阻读数只置 blocked。
   */
  judge(readings: readonly string[], now: number = Date.now()): CalibrationResult {
    const result = judgeCalibration(readings.slice());
    if (result.verdict === 'blocked') {
      this.state = { status: 'blocked', readings: result.readings.map((point) => point.raw) };
      return result;
    }
    const snapshot = snapshotFromResult(result, now);
    this.state = result.verdict === 'pass' ? { status: 'pass', snapshot } : { status: 'adjust', snapshot };
    return result;
  }

  /** 任一读数被改动：上次结论（含存档恢复的结论）立即失效。 */
  editReadings(_next: readonly string[]): void {
    // 调用方（输入监听 / 存档恢复）只在读数确实不同于判定快照时调用；
    // 进入 drafting 表示“上次结论已失效，需重新判定”。
    this.state = { status: 'drafting' };
  }

  /**
   * 从完整、版本相符的存档恢复历史展示。
   * 记录本身只决定“展示什么”，绝不把旧单自动当作当前授权：
   * 恢复出的合格结论状态固定为 restored-pass。
   */
  restore(record: CalibrationRecord, source: RestoreSource = 'load'): void {
    const result = judgeCalibration(record.readings);
    if (result.verdict === 'blocked') {
      this.state = { status: 'blocked', readings: result.readings.map((point) => point.raw) };
      this.restoreSource = source;
      return;
    }
    const snapshot: CalibrationSnapshotView = snapshotFromResult(result, record.judgedAt);
    this.state = result.verdict === 'pass' ? { status: 'restored-pass', snapshot } : { status: 'restored-adjust', snapshot };
    this.restoreSource = source;
  }

  /** 清空（如存档损坏或用户清空重填）。 */
  reset(): void {
    this.state = { status: 'idle' };
  }
}
