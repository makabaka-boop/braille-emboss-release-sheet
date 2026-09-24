<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  MAX_HEIGHT,
  MAX_SPREAD,
  MIN_HEIGHT,
  POINT_COUNT,
  POINT_LABELS,
  createDraft,
  formatHeight,
  judgeCalibration,
  type CalibrationResult,
  type PointJudgmentView,
  type PointReadingView
} from '../lib/calibration';
import { clearCalibrationState, loadCalibrationState, saveCalibrationState } from '../lib/calibrationStorage';

/**
 * 试压校准工作区：只消费校准领域服务输出的契约，
 * 不读取也不改写单稿预检或双稿核对的任何状态。
 * 未提交草稿与成功判定所用读数自动存入 localStorage，刷新后恢复。
 */
const restored = loadCalibrationState();

const readings = ref<string[]>(restored.draft.readings.slice());
const result = ref<CalibrationResult | null>(restored.result);
const judgedRaws = ref<string[] | null>(restored.judgedRaws);
const archiveWarning = ref(restored.warning?.message ?? null);
const isProtectedArchive = ref(restored.protected);
const storageError = ref<string | null>(null);
let skipNextDraftWatch = false;

const pointIndices = Array.from({ length: POINT_COUNT }, (_, index) => index);

const blockedReadings = computed<PointReadingView[]>(() =>
  result.value?.verdict === 'blocked' ? result.value.readings : []
);

const judgedPoints = computed<PointJudgmentView[]>(() =>
  result.value?.verdict === 'pass' || result.value?.verdict === 'adjust' ? result.value.readings : []
);

const threshold = computed(() =>
  result.value?.verdict === 'pass' || result.value?.verdict === 'adjust' ? result.value.threshold : null
);

function pointError(index: number): string | null {
  return blockedReadings.value[index]?.error?.message ?? null;
}

function judgedPoint(index: number): PointJudgmentView | null {
  return judgedPoints.value[index] ?? null;
}

function runJudge() {
  const judged = judgeCalibration(readings.value);
  result.value = judged;
  if (judged.verdict === 'blocked') {
    // 无效读数只构成输入受阻，不保留为本次判定结果，也不覆盖受保护原存档。
    judgedRaws.value = null;
    return;
  }

  const snapshot = readings.value.slice();
  const saved = saveCalibrationState({ readings: snapshot }, snapshot);
  if (saved) {
    judgedRaws.value = snapshot;
    archiveWarning.value = null;
    storageError.value = null;
    isProtectedArchive.value = false;
  } else {
    judgedRaws.value = snapshot;
    isProtectedArchive.value = true;
    storageError.value =
      '浏览器本地存储写入失败（可能是配额不足或权限受限）：本次判定未写入，原始存档仍保留。修复存储问题后请重新执行判定；在此之前任何修改都不会覆盖原存档。';
  }
}

function resetAll() {
  if (isProtectedArchive.value) {
    storageError.value = '原始校准存档仍在保护中：请核对并重新执行判定；在新的有效判定写入前不能清空覆盖。';
    return;
  }

  const cleared = clearCalibrationState();
  if (!cleared) {
    storageError.value = '清空本地校准存档失败：原存档仍保留，请检查浏览器存储权限。';
    return;
  }

  skipNextDraftWatch = true;
  readings.value = createDraft().readings;
  result.value = null;
  judgedRaws.value = null;
  archiveWarning.value = null;
  storageError.value = null;
}

// 判定之后只要任一读数再被改动，上次结论立即失效。
// 异常存档处于保护态时，用户修改只保留在内存取证，不自动覆盖 localStorage。
watch(
  readings,
  (values) => {
    if (skipNextDraftWatch) {
      skipNextDraftWatch = false;
      return;
    }

    if (result.value !== null) {
      result.value = null;
      judgedRaws.value = null;
    }
    if (isProtectedArchive.value) {
      storageError.value = '原存档异常且处于保护中：当前修改仅用于本次核对，重新执行有效判定前不会写入或覆盖原存档。';
      return;
    }

    const saved = saveCalibrationState({ readings: values.slice() }, null);
    if (saved) {
      storageError.value = null;
    } else {
      isProtectedArchive.value = true;
      storageError.value =
        '草稿保存失败（可能是配额不足或权限受限）：浏览器仍保留最近一次可恢复的本地记录；后续修改将继续留在本次会话，不会覆盖原存档。';
    }
  },
  { deep: true }
);
</script>

<template>
  <section
    v-if="archiveWarning"
    class="panel errors calibration-archive-warning"
    role="alert"
    data-testid="calibration-archive-warning"
  >
    <h2>本地校准存档不可安全恢复</h2>
    <p>{{ archiveWarning }}</p>
  </section>

  <section
    v-if="storageError"
    class="panel errors calibration-storage-error"
    role="alert"
    data-testid="calibration-storage-error"
  >
    <h2>本地存储写入失败</h2>
    <p>{{ storageError }}</p>
  </section>

  <section class="panel calibration-input" aria-label="试压校准录入">
    <p class="calibration-note">
      换模或保养后先压一张六点试压片：为 1 至 6 号点分别录入一次凸点高度（毫米），再执行判定。
      单点合格范围固定为 {{ MIN_HEIGHT.toFixed(2) }}–{{ MAX_HEIGHT.toFixed(2) }} 毫米，六点极差不得超过
      {{ MAX_SPREAD.toFixed(2) }} 毫米。校准结果独立保存，不影响单稿预检与双稿核对。
    </p>

    <ol class="point-grid" data-testid="point-grid">
      <li v-for="index in pointIndices" :key="index" class="point-field">
        <label class="point-label" :for="`height-input-${index + 1}`">{{ POINT_LABELS[index] }}</label>
        <span class="point-input-wrap">
          <input
            :id="`height-input-${index + 1}`"
            v-model="readings[index]"
            type="text"
            inputmode="decimal"
            spellcheck="false"
            placeholder="0.75"
            class="height-input"
            :class="{ 'input-invalid': pointError(index) !== null }"
            :aria-invalid="pointError(index) !== null"
            :aria-describedby="pointError(index) ? `height-error-${index + 1}` : undefined"
            :data-testid="`height-input-${index + 1}`"
          />
          <span class="unit">毫米</span>
        </span>
        <span v-if="pointError(index)" :id="`height-error-${index + 1}`" class="point-error" role="alert" :data-testid="`height-error-${index + 1}`">
          {{ pointError(index) }}
        </span>
      </li>
    </ol>

    <div class="calibration-actions">
      <button type="button" class="compare-btn" data-testid="calibration-judge" @click="runJudge">执行判定</button>
      <button type="button" class="calibration-clear" data-testid="calibration-clear" @click="resetAll">清空重填</button>
    </div>
  </section>

  <section
    v-if="result?.verdict === 'blocked'"
    class="panel errors calibration-blocked"
    role="alert"
    data-testid="calibration-blocked"
  >
    <h2>读数无效，已停止判定</h2>
    <p>{{ result.conclusion }}</p>
  </section>

  <section
    v-else-if="result"
    class="panel calibration-result"
    :class="`verdict-${result.verdict}`"
    :data-verdict="result.verdict"
    data-testid="calibration-result"
    aria-label="试压校准结果"
  >
    <h2>{{ result.verdict === 'pass' ? '试压校准：合格' : '试压校准：需调机' }}</h2>

    <table class="point-table">
      <thead>
        <tr>
          <th scope="col">点位</th>
          <th scope="col">实测值（毫米）</th>
          <th scope="col">单点判定</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="index in pointIndices" :key="index" class="point-row" :data-testid="`point-row-${index + 1}`">
          <td>{{ POINT_LABELS[index] }}</td>
          <td class="point-value" data-testid="point-value">{{ formatHeight(judgedPoint(index)?.value ?? 0) }}</td>
          <td>
            <span
              v-if="judgedPoint(index)?.inRange"
              class="point-tag ok"
              :data-testid="`point-status-${index + 1}`"
            >合格</span>
            <span v-else class="point-tag bad" :data-testid="`point-status-${index + 1}`">
              {{ judgedPoint(index)?.outReason?.message }}
            </span>
          </td>
        </tr>
      </tbody>
    </table>

    <dl v-if="threshold" class="threshold-summary" data-testid="threshold-summary">
      <div><dt>最小</dt><dd>{{ formatHeight(threshold.min) }} 毫米</dd></div>
      <div><dt>最大</dt><dd>{{ formatHeight(threshold.max) }} 毫米</dd></div>
      <div>
        <dt>极差</dt>
        <dd :class="{ bad: !threshold.spreadOk }">
          {{ formatHeight(threshold.spread) }} 毫米（限值 {{ formatHeight(threshold.spreadLimit) }} 毫米）
        </dd>
      </div>
    </dl>

    <p class="calibration-conclusion" role="status" data-testid="calibration-conclusion">
      {{ result.conclusion }}
    </p>
  </section>
</template>
