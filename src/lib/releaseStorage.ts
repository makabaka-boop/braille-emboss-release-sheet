/**
 * 压点放行单的本地持久化（localStorage）。
 *
 * 与校准存档相互独立：放行单一旦签发即为**不可变快照**，本模块只提供
 * “追加签发 / 只读载入”，不提供修改或删除，草稿永远不可能覆盖历史放行单。
 *
 * 安全约束（与校准存档同一套取证原则）：
 *  - 只接受完整、版本相符且能由领域服务重新复算一致的记录；
 *  - 存档损坏时尽可能抢救其中完整可验的放行单用于只读复核，并明确告警、
 *    进入保护态：普通刷新不会写回，只有用户凭新的“合格”判定显式签发新单
 *    时才会连同抢救出的历史单一起重写；
 *  - 写入失败（配额 / 权限）返回失败并保留最近一次完整记录（内存与磁盘），
 *    界面必须明确告警。
 */
import { judgeCalibration } from './calibration';
import { buildReleaseDraft, type ReleasePermit } from './release';

const STORAGE_KEY = 'braille-plate:release:v1';
const CURRENT_VERSION = 1;

export type ReleaseStorageWarningKind = 'corrupted-record' | 'unknown-version' | 'write-failed' | 'duplicate-id';

export interface ReleaseStorageWarning {
  kind: ReleaseStorageWarningKind;
  message: string;
}

export interface ReleaseStoreState {
  /** 载入并校验通过（或本次会话内存中保留）的放行单，按签发时间升序。 */
  permits: ReleasePermit[];
  warning: ReleaseStorageWarning | null;
  /** 磁盘存档异常且尚未被一次新的成功签发重写时为 true。 */
  protected: boolean;
}

export interface AppendResult {
  ok: boolean;
  /** 写后（或写入失败时内存中保留）的完整放行单列表。 */
  permits: ReleasePermit[];
  warning: ReleaseStorageWarning | null;
}

interface RawRecord {
  version?: unknown;
  permits?: unknown;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function warn(kind: ReleaseStorageWarningKind, detail: string): ReleaseStorageWarning {
  const prefix = '压点放行单存档异常：';
  switch (kind) {
    case 'corrupted-record':
      return {
        kind,
        message: `${prefix}字段缺失、类型损坏或快照内容与重新复算结果不一致。${detail}已保留最近一次完整记录供只读复核，请重新完成合格判定后再签发；在那之前不会自动写回。`
      };
    case 'unknown-version':
      return {
        kind,
        message: `${prefix}存档版本无法识别，不能信任其中的放行单内容。${detail}请重新完成合格判定后再签发。`
      };
    case 'duplicate-id':
      return {
        kind,
        message: `${prefix}存在同一标识但内容不同的记录。${detail}冲突记录未写入，已保留最近一次完整记录。`
      };
    case 'write-failed':
      return {
        kind,
        message:
          '压点放行单写入失败（可能是本地存储配额不足或权限受限）：磁盘上的历史放行单保持不变，' +
          '本次放行单仅保留在当前会话中可只读复核；请修复存储问题后重新完成合格判定并签发。'
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验一条未知来源的放行单：形状完整、单稿可重新复算一致、
 * 六点读数重新判定为“合格”且阈值/数值一致，才作为可信记录返回。
 */
export function validateStoredPermit(entry: unknown): ReleasePermit | null {
  if (!isRecord(entry)) {
    return null;
  }
  const { id, issuedAt, draft, calibration } = entry as Record<string, unknown>;
  if (typeof id !== 'string' || id.trim() === '' || typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
    return null;
  }
  if (!isRecord(draft) || !isRecord(calibration)) {
    return null;
  }

  const { text, width, cells, lines, totalCells } = draft as Record<string, unknown>;
  if (typeof text !== 'string' || typeof width !== 'number' || !Array.isArray(cells) || !Array.isArray(lines) || typeof totalCells !== 'number') {
    return null;
  }
  if (!cells.every((cell) => typeof cell === 'string')) {
    return null;
  }
  if (
    !lines.every((line) => Array.isArray(line) && line.every((cell) => typeof cell === 'string'))
  ) {
    return null;
  }

  const rebuilt = buildReleaseDraft(text, width);
  if (!rebuilt.ok) {
    return null;
  }
  const d = rebuilt.draft;
  if (
    d.width !== width ||
    d.totalCells !== totalCells ||
    JSON.stringify(d.cells) !== JSON.stringify(cells) ||
    JSON.stringify(d.lines) !== JSON.stringify(lines)
  ) {
    return null;
  }

  const calibrationRecord = calibration as Record<string, unknown>;
  if (calibrationRecord.verdict !== 'pass' || !Array.isArray(calibrationRecord.readings)) {
    return null;
  }
  const readings = calibrationRecord.readings;
  if (readings.length !== 6 || !readings.every((item) => typeof item === 'string')) {
    return null;
  }
  const result = judgeCalibration(readings as string[]);
  if (result.verdict !== 'pass') {
    return null;
  }
  const values = result.readings.map((point) => point.value);
  if (!Array.isArray(calibrationRecord.values) || JSON.stringify(calibrationRecord.values) !== JSON.stringify(values)) {
    return null;
  }
  if (!isRecord(calibrationRecord.threshold) || JSON.stringify(calibrationRecord.threshold) !== JSON.stringify(result.threshold)) {
    return null;
  }
  if (calibrationRecord.conclusion !== result.conclusion) {
    return null;
  }
  if (
    typeof calibrationRecord.judgedAt !== 'number' ||
    !Number.isFinite(calibrationRecord.judgedAt)
  ) {
    return null;
  }

  const points = result.readings.map((point) => ({ ...point }));
  const normalized: ReleasePermit = {
    id,
    issuedAt,
    draft: {
      text,
      width,
      cells: cells as string[],
      lines: lines as string[][],
      totalCells
    },
    calibration: {
      verdict: 'pass',
      readings: readings as string[],
      values,
      points,
      threshold: { ...result.threshold },
      conclusion: result.conclusion,
      judgedAt: typeof calibrationRecord.judgedAt === 'number' ? (calibrationRecord.judgedAt as number) : 0
    }
  };
  return Object.freeze(normalized);
}

function readDisk(): { permits: ReleasePermit[]; warning: ReleaseStorageWarning | null; damaged: boolean; raw: string | null } {
  const store = storage();
  if (!store) {
    return { permits: [], warning: null, damaged: false, raw: null };
  }

  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { permits: [], warning: warn('corrupted-record', '浏览器存储当前不可读取。'), damaged: true, raw: null };
  }
  if (raw === null) {
    return { permits: [], warning: null, damaged: false, raw: null };
  }

  let parsed: RawRecord;
  try {
    parsed = JSON.parse(raw) as RawRecord;
  } catch {
    return { permits: [], warning: warn('corrupted-record', '存档不是合法 JSON。'), damaged: true, raw };
  }
  if (!isRecord(parsed)) {
    return { permits: [], warning: warn('corrupted-record', '存档顶层结构已损坏。'), damaged: true, raw };
  }
  if (parsed.version !== CURRENT_VERSION) {
    return { permits: [], warning: warn('unknown-version', '已保留原始存档，未做任何改动。'), damaged: true, raw };
  }
  if (!Array.isArray(parsed.permits)) {
    return { permits: [], warning: warn('corrupted-record', '放行单列表字段缺失或类型错误。'), damaged: true, raw };
  }

  const permits: ReleasePermit[] = [];
  let damagedCount = 0;
  const seenIds = new Set<string>();
  let duplicated = false;
  for (const entry of parsed.permits) {
    const permit = validateStoredPermit(entry);
    if (!permit) {
      damagedCount += 1;
      continue;
    }
    if (seenIds.has(permit.id)) {
      duplicated = true;
      continue;
    }
    seenIds.add(permit.id);
    permits.push(permit);
  }

  permits.sort((a, b) => a.issuedAt - b.issuedAt || a.id.localeCompare(b.id));

  if (damagedCount > 0) {
    return {
      permits,
      warning: warn('corrupted-record', `其中 ${damagedCount} 条记录无法通过校验，未予展示。`),
      damaged: true,
      raw
    };
  }
  if (duplicated) {
    return { permits, warning: warn('duplicate-id', '检测到重复标识。'), damaged: true, raw };
  }
  return { permits, warning: null, damaged: false, raw };
}

/** 载入放行单存档（页面初始化与跨标签页 storage 事件使用）。 */
export function loadReleaseStore(): ReleaseStoreState {
  const disk = readDisk();
  if (!disk.warning) {
    return { permits: disk.permits, warning: null, protected: false };
  }
  return { permits: disk.permits, warning: disk.warning, protected: disk.damaged };
}

function mergePermits(lists: readonly (readonly ReleasePermit[])[]): { merged: ReleasePermit[] | null; conflict: boolean } {
  const byId = new Map<string, ReleasePermit>();
  let conflict = false;
  for (const list of lists) {
    for (const permit of list) {
      const existing = byId.get(permit.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(permit)) {
          conflict = true;
        }
        continue;
      }
      byId.set(permit.id, permit);
    }
  }
  if (conflict) {
    return { merged: null, conflict: true };
  }
  const merged = Array.from(byId.values()).sort((a, b) => a.issuedAt - b.issuedAt || a.id.localeCompare(b.id));
  return { merged, conflict: false };
}

/**
 * 追加签发一张放行单。磁盘记录会与内存中保留的最近一次完整记录合并后整体
 * 重写（同标识内容冲突时拒绝写入）；损坏 / 未知版本磁盘存档在此显式签发
 * 动作下允许被“抢救记录 + 新单”替换。
 */
export function appendReleasePermit(permit: ReleasePermit, memoryPermits: readonly ReleasePermit[]): AppendResult {
  if (!Object.isFrozen(permit)) {
    return { ok: false, permits: memoryPermits.slice(), warning: warn('corrupted-record', '放行单未经领域冻结，拒绝写入。') };
  }
  const disk = readDisk();
  const { merged, conflict } = mergePermits([disk.permits, memoryPermits, [permit]]);
  if (conflict || !merged) {
    const retained = mergePermits([disk.permits, memoryPermits]).merged ?? memoryPermits.slice();
    return { ok: false, permits: retained, warning: warn('duplicate-id', '本次签发已取消。') };
  }

  // 防御：合并结果中的新单必须与领域签发内容逐字一致。
  const stored = merged.find((item) => item.id === permit.id);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(permit)) {
    return { ok: false, permits: merged, warning: warn('corrupted-record', '合并后快照与签发内容不一致。') };
  }

  const store = storage();
  if (!store) {
    return { ok: false, permits: merged, warning: warn('write-failed', '浏览器存储不可用。') };
  }
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ version: CURRENT_VERSION, permits: merged }));
  } catch {
    // 配额 / 权限失败：磁盘记录原样保留，内存中保留含新单在内的完整列表。
    return { ok: false, permits: merged, warning: warn('write-failed', '') };
  }
  return { ok: true, permits: merged, warning: null };
}

/** 存储键对外暴露，供跨标签监听与测试使用。 */
export const RELEASE_STORAGE_KEY = STORAGE_KEY;
