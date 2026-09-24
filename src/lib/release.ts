/**
 * 压点放行单领域服务（纯函数，不访问网络、存储或 DOM）。
 *
 * 制版员完成铭牌文字预检后，只有确认“当前”一次六点试压合格，才允许交付
 * 一份可复核的压点放行单。放行单把以下内容固化为**同一个不可变快照**：
 *
 *  - 合法单稿的原文、行宽、逐方编码与逐行排版结果；
 *  - 一次**新完成**的“合格”校准判定（结论、阈值汇总与六点读数）。
 *
 * “需调机”、受阻读数、非法文字（空文本 / 非法字符 / 非法行宽）或仅靠
 * 刷新 / 跨标签页恢复的旧版校准存档都不能放行——后者必须重新执行判定。
 *
 * 本模块只输出判定与快照契约；会话内“当前判定”的来源（本次新判定还是
 * 存档恢复）由 releaseSession.ts 维护，持久化由 releaseStorage.ts 负责。
 */
import { encodePhrase } from './braille';
import { layoutLines, validateWidth } from './layout';
import {
  formatHeight,
  judgeCalibration,
  type CalibrationResult,
  type PointJudgmentView,
  type ThresholdSummary
} from './calibration';

/** 放行单固化的单稿快照：原文、行宽、逐方编码与排版结果。 */
export interface ReleaseDraftSnapshot {
  /** 单稿原文（逐字保存，不再二次改写）。 */
  text: string;
  /** 每行方数（4–20 的整数）。 */
  width: number;
  /** 逐方编码（含数字符 3456 与空方），排版前的方序。 */
  cells: string[];
  /** 逐行排版结果；不拆分编码方，末行不补齐。 */
  lines: string[][];
  /** 总方数。 */
  totalCells: number;
}

/** 放行单固化的校准快照：一次“合格”判定及其六点读数。 */
export interface ReleaseCalibrationSnapshot {
  verdict: 'pass';
  /** 六点原始录入文本，与单稿快照同一次固化。 */
  readings: string[];
  /** 六点解析后的实测值（毫米）。 */
  values: number[];
  /** 逐点判定视图。 */
  points: PointJudgmentView[];
  /** 整机阈值汇总。 */
  threshold: ThresholdSummary;
  /** 判定结论文本。 */
  conclusion: string;
  /** 判定完成时间（毫秒时间戳）。 */
  judgedAt: number;
}

/** 一张不可变的压点放行单：独立标识 + 来源快照。 */
export interface ReleasePermit {
  /** 放行单独立标识，全库唯一，一经签发不再改变。 */
  id: string;
  /** 签发时间（毫秒时间戳）。 */
  issuedAt: number;
  draft: ReleaseDraftSnapshot;
  calibration: ReleaseCalibrationSnapshot;
}

/**
 * 会话内校准判定状态。
 * 只有 status 为 'pass' 才表示“本次新完成的合格判定”，可用于放行；
 * restored-* 来自刷新或跨标签页恢复的存档，不能自动成为当前授权。
 */
export type LiveCalibration =
  | { status: 'idle' }
  | { status: 'drafting' }
  | { status: 'blocked'; readings: string[] }
  | { status: 'pass'; snapshot: CalibrationSnapshotView }
  | { status: 'adjust'; snapshot: CalibrationSnapshotView }
  | { status: 'restored-pass'; snapshot: CalibrationSnapshotView }
  | { status: 'restored-adjust'; snapshot: CalibrationSnapshotView };

/** 一次完整校准判定（合格 / 需调机）的可展示视图。 */
export interface CalibrationSnapshotView {
  readings: string[];
  values: number[];
  points: PointJudgmentView[];
  threshold: ThresholdSummary;
  conclusion: string;
  judgedAt: number;
}

/** 放行被阻止的离散原因，界面据此逐项展示。 */
export type ReleaseGateReason =
  | 'empty-text'
  | 'illegal-character'
  | 'illegal-width'
  | 'no-judgment'
  | 'readings-blocked'
  | 'verdict-adjust'
  | 'restored-archive';

export interface ReleaseGate {
  /** 合法单稿 + 本次新完成的合格判定同时满足才为 true。 */
  releasable: boolean;
  /** 单稿合法时携带可直接固化的单稿快照，否则为 null。 */
  draft: ReleaseDraftSnapshot | null;
  /** 阻止原因（与 messages 一一对应）。 */
  reasons: ReleaseGateReason[];
  /** 面向制版员的中文说明。 */
  messages: string[];
  /** 计算时依据的会话校准状态。 */
  live: LiveCalibration;
}

export const GATE_REASON_MESSAGES: Record<ReleaseGateReason, string> = {
  'empty-text': '单稿预检未通过：原文为空，没有可固化的合法单稿。',
  'illegal-character': '单稿预检未通过：原文含非法字符，非法文字不能放行。',
  'illegal-width': '单稿预检未通过：行宽不是 4–20 之间的整数，不能放行。',
  'no-judgment': '试压校准尚未形成当前有效判定：请在试压校准工作区录入完整六点并执行判定。',
  'readings-blocked': '六点试压存在无效读数，判定受阻：请按点位提示修正后重新执行判定。',
  'verdict-adjust': '最近一次六点试压判定为“需调机”：调整设备并重新试压合格前不能放行。',
  'restored-archive':
    '当前校准结论来自刷新或跨标签页恢复的存档，不是本次新完成的判定：请重新执行“合格”判定后再放行。'
};

const DRAFTING_MESSAGE =
  '六点读数在上次判定之后被改动过，原结论已立即失效：请重新执行判定，凭新的“合格”结果放行。';

type BuildDraftResult =
  | { ok: true; draft: ReleaseDraftSnapshot }
  | { ok: false; reasons: ReleaseGateReason[]; messages: string[] };

function reasonFromEncodeError(kind: 'illegal-character' | 'empty-text'): ReleaseGateReason {
  return kind === 'empty-text' ? 'empty-text' : 'illegal-character';
}

/**
 * 由当前单稿原文与行宽构造可固化快照。
 * 复用预检同一套编码 / 行宽契约：空文本、非法字符或非法行宽一律拒绝。
 */
export function buildReleaseDraft(text: string, rawWidth: string | number): BuildDraftResult {
  const { cells, errors: encodeErrors } = encodePhrase(text);
  const widthError = validateWidth(rawWidth);

  const reasons: ReleaseGateReason[] = [];
  const messages: string[] = [];
  for (const error of encodeErrors) {
    const reason = reasonFromEncodeError(error.kind);
    if (!reasons.includes(reason)) {
      reasons.push(reason);
      messages.push(GATE_REASON_MESSAGES[reason]);
    }
  }
  if (widthError) {
    reasons.push('illegal-width');
    messages.push(GATE_REASON_MESSAGES['illegal-width']);
  }

  if (reasons.length > 0) {
    return { ok: false, reasons, messages };
  }

  const width = typeof rawWidth === 'number' ? rawWidth : Number(String(rawWidth).trim());
  const lines = layoutLines(cells, width);

  return {
    ok: true,
    draft: {
      text,
      width,
      cells: cells.slice(),
      lines: lines.map((line) => line.slice()),
      totalCells: cells.length
    }
  };
}

/**
 * 计算当前放行闸门：合法单稿且会话校准状态为“本次新完成的合格判定”才可放行。
 */
export function evaluateGate(text: string, rawWidth: string | number, live: LiveCalibration): ReleaseGate {
  const built = buildReleaseDraft(text, rawWidth);
  const reasons: ReleaseGateReason[] = [];
  const messages: string[] = [];

  if (built.ok) {
    return {
      releasable: live.status === 'pass',
      draft: built.draft,
      reasons: live.status === 'pass' ? [] : [calibrationReason(live.status)],
      messages: live.status === 'pass' ? [] : [calibrationMessage(live)],
      live
    };
  }

  reasons.push(...built.reasons);
  messages.push(...built.messages);

  // 单稿不合法时仍如实给出校准侧状态，便于制版员一次性看清全部阻断项。
  if (live.status !== 'pass') {
    reasons.push(calibrationReason(live.status));
    messages.push(calibrationMessage(live));
  }

  return { releasable: false, draft: null, reasons, messages, live };
}

function calibrationReason(status: LiveCalibration['status']): ReleaseGateReason {
  switch (status) {
    case 'blocked':
      return 'readings-blocked';
    case 'adjust':
      return 'verdict-adjust';
    case 'restored-pass':
    case 'restored-adjust':
      return 'restored-archive';
    case 'idle':
    case 'drafting':
    case 'pass':
      return 'no-judgment';
  }
}

function calibrationMessage(live: LiveCalibration): string {
  switch (live.status) {
    case 'idle':
      return GATE_REASON_MESSAGES['no-judgment'];
    case 'drafting':
      return DRAFTING_MESSAGE;
    case 'blocked':
      return GATE_REASON_MESSAGES['readings-blocked'];
    case 'adjust':
      return GATE_REASON_MESSAGES['verdict-adjust'];
    case 'restored-pass':
    case 'restored-adjust': {
      const verdictText = live.status === 'restored-pass' ? '合格' : '需调机';
      return `存档恢复的是一次“${verdictText}”校准结论。${GATE_REASON_MESSAGES['restored-archive']}`;
    }
    case 'pass':
      return '';
  }
}

/** 由一次合格 / 需调机判定结果构造会话快照视图（持久化恢复时 judgedAt 传 0）。 */
export function snapshotFromResult(
  result: Extract<CalibrationResult, { verdict: 'pass' | 'adjust' }>,
  judgedAt: number
): CalibrationSnapshotView {
  return {
    readings: result.readings.map((point) => point.raw),
    values: result.readings.map((point) => point.value),
    points: result.readings.map((point) => ({ ...point })),
    threshold: { ...result.threshold },
    conclusion: result.conclusion,
    judgedAt
  };
}

export function sameSixReadings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === 6 && right.length === 6 && left.every((value, index) => value === right[index]);
}

function draftsEqual(left: ReleaseDraftSnapshot, right: ReleaseDraftSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value as object)) {
      const child = (value as Record<PropertyKey, unknown>)[key as PropertyKey];
      if (child !== null && typeof child === 'object') {
        deepFreeze(child);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 默认标识：YF-年月日-时分秒-6 位随机串，便于车间复核时口报与抄写。 */
function defaultPermitId(now: number): string {
  const date = new Date(now);
  const stamp =
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let random = '';
  for (let i = 0; i < 6; i += 1) {
    random += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `YF-${stamp}-${random}`;
}

export interface IssuePermitDeps {
  now?: () => number;
  randomId?: (now: number) => string;
}

/**
 * 签发一张放行单：入参快照必须重新通过领域校验，且校准状态必须是
 * “本次新完成的合格判定”。返回的放行单（含来源快照）被整体冻结。
 */
export function issueReleasePermit(
  draft: ReleaseDraftSnapshot,
  live: LiveCalibration,
  deps: IssuePermitDeps = {}
): ReleasePermit {
  const recheck = buildReleaseDraft(draft.text, draft.width);
  if (!recheck.ok || !draftsEqual(recheck.draft, draft)) {
    throw new TypeError('放行单的单稿快照无法重新形成完全一致的合法排版，拒绝签发。');
  }
  if (live.status !== 'pass') {
    throw new TypeError('只有本次新完成的“合格”校准判定才能签发放行单。');
  }

  const { snapshot } = live;
  const result = judgeCalibration(snapshot.readings);
  if (result.verdict !== 'pass') {
    throw new TypeError('放行固化时六点读数重新判定不再合格，拒绝签发。');
  }
  const rejudged = snapshotFromResult(result, snapshot.judgedAt);
  if (
    !sameSixReadings(snapshot.readings, rejudged.readings) ||
    JSON.stringify(snapshot.values) !== JSON.stringify(rejudged.values) ||
    JSON.stringify(snapshot.threshold) !== JSON.stringify(rejudged.threshold)
  ) {
    throw new TypeError('放行固化的校准快照与重新判定结果不一致，拒绝签发。');
  }

  const now = deps.now ?? Date.now;
  const issuedAt = now();
  const id = deps.randomId ? deps.randomId(issuedAt) : defaultPermitId(issuedAt);
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError('放行单标识不能为空。');
  }

  const permit: ReleasePermit = {
    id,
    issuedAt,
    draft: {
      text: draft.text,
      width: draft.width,
      cells: draft.cells.slice(),
      lines: draft.lines.map((line) => line.slice()),
      totalCells: draft.totalCells
    },
    calibration: {
      verdict: 'pass',
      readings: snapshot.readings.slice(),
      values: snapshot.values.slice(),
      points: snapshot.points.map((point) => ({ ...point, outReason: point.outReason ? { ...point.outReason } : null })),
      threshold: { ...snapshot.threshold },
      conclusion: snapshot.conclusion,
      judgedAt: snapshot.judgedAt
    }
  };

  return deepFreeze(permit);
}

/**
 * 判断一张已签发的放行单是否仍是“当前授权”：
 * 屏幕上的原文、行宽与本次合格读数必须与来源快照完全一致；
 * 任一处改动（或判定不再是当前合格）都使其退为只读历史单。
 */
export function isPermitCurrent(
  permit: ReleasePermit,
  text: string,
  rawWidth: string | number,
  live: LiveCalibration
): boolean {
  if (live.status !== 'pass') {
    return false;
  }
  const rebuilt = buildReleaseDraft(text, rawWidth);
  if (!rebuilt.ok) {
    return false;
  }
  return (
    rebuilt.draft.text === permit.draft.text &&
    rebuilt.draft.width === permit.draft.width &&
    rebuilt.draft.totalCells === permit.draft.totalCells &&
    sameSixReadings(live.snapshot.readings, permit.calibration.readings)
  );
}

/** 把放行单中的六点读数格式化为展示用两位小数字符串。 */
export function permitHeightText(permit: ReleasePermit, index: number): string {
  return formatHeight(permit.calibration.values[index]);
}
