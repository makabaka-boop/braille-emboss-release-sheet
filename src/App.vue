<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { planPlate } from './lib/precheck';
import { encodePhrase } from './lib/braille';
import { MAX_WIDTH, MIN_WIDTH, validateWidth } from './lib/layout';
import { compareDrafts, type CompareResult, type DiffOp } from './lib/compare';
import CellView from './components/CellView.vue';
import CalibrationWorkspace from './components/CalibrationWorkspace.vue';
import TrainingWorkspace from './components/TrainingWorkspace.vue';
import ReleasePanel from './components/ReleasePanel.vue';
import { CalibrationSession, type CalibrationLiveState } from './lib/releaseSession';
import { CALIBRATION_STORAGE_KEY, loadCalibrationState } from './lib/calibrationStorage';

const mode = ref<'single' | 'compare' | 'calibration' | 'training'>('single');

// ---- 压点放行共享的校准会话 ----
// 单稿预检放行闸门与试压校准工作区共用同一个会话状态机：
// 只有本次新完成的“合格”判定可放行；刷新 / 跨标签页恢复的旧存档只能展示。
const calibrationSession = new CalibrationSession();
const liveCalibration = ref<CalibrationLiveState>(calibrationSession.getLive());

// 页面初始（默认进入单稿预检）即按校准存档恢复历史展示，但不给授权。
{
  const restored = loadCalibrationState();
  if (restored.result && restored.judgedRaws) {
    calibrationSession.restore({ judgedAt: 0, readings: restored.judgedRaws }, 'load');
  } else if (restored.draft.readings.some((value) => value.trim() !== '')) {
    calibrationSession.editReadings(restored.draft.readings);
  }
  liveCalibration.value = calibrationSession.getLive();
}

function onCalibrationLiveChange(live: CalibrationLiveState) {
  liveCalibration.value = live;
}

/**
 * 跨标签页收到校准更新：只能依据完整、版本相符的记录恢复**历史展示**，
 * 绝不能把另一标签页的旧“合格”单自动当作当前标签页的放行授权。
 * 因此本标签页已有本次新判定（pass / adjust）时，跨标签事件不降级会话。
 */
function onStorage(event: StorageEvent) {
  if (event.storageArea !== window.localStorage || event.key !== CALIBRATION_STORAGE_KEY) {
    return;
  }
  const current = calibrationSession.getLive();
  if (current.status === 'pass' || current.status === 'adjust') {
    return;
  }
  const restored = loadCalibrationState();
  if (restored.warning || !restored.result || !restored.judgedRaws) {
    calibrationSession.reset();
    if (restored.draft.readings.some((value) => value.trim() !== '')) {
      calibrationSession.editReadings(restored.draft.readings);
    }
  } else {
    calibrationSession.restore({ judgedAt: 0, readings: restored.judgedRaws }, 'storage-event');
  }
  liveCalibration.value = calibrationSession.getLive();
}
window.addEventListener('storage', onStorage);
onBeforeUnmount(() => {
  window.removeEventListener('storage', onStorage);
});

// ---- 单稿预检（既有输入与结论不变，新增放行闸门） ----
const phrase = ref('');
const widthInput = ref('12');
const widthChoices = [4, 8, 12, 16, 20];

const plan = computed(() => planPlate(phrase.value, widthInput.value));
const hasOutput = computed(() => plan.value.errors.length === 0 && plan.value.totalCells > 0);

// 逐字段定位阻断原因，让对应输入框获得错误状态并与警告文案关联。
const phraseInvalid = computed(() => encodePhrase(phrase.value).errors.length > 0);
const widthInvalid = computed(() => validateWidth(widthInput.value) !== null);

// ---- 双稿核对：粘贴两稿后点击“发起核对”，结果为一次性差异记录 ----
const baseDraft = ref('');
const targetDraft = ref('');
const compareResult = ref<CompareResult | null>(null);

const identicalResult = computed(() => (compareResult.value?.verdict === 'identical' ? compareResult.value : null));
const differentResult = computed(() => (compareResult.value?.verdict === 'different' ? compareResult.value : null));
const blockedResult = computed(() => (compareResult.value?.verdict === 'blocked' ? compareResult.value : null));
const baseErrors = computed(() => blockedResult.value?.baseErrors ?? []);
const targetErrors = computed(() => blockedResult.value?.targetErrors ?? []);

const diffCounts = computed(() => {
  if (!differentResult.value) {
    return { insert: 0, delete: 0, replace: 0 };
  }
  const counts = { insert: 0, delete: 0, replace: 0 };
  for (const entry of differentResult.value.entries) {
    if (entry.op !== 'equal') {
      counts[entry.op] += 1;
    }
  }
  return counts;
});

const OP_LABELS: Record<DiffOp, string> = {
  equal: '相同',
  insert: '插入',
  delete: '删除',
  replace: '替换'
};

function runCompare() {
  compareResult.value = compareDrafts(baseDraft.value, targetDraft.value);
}
</script>

<template>
  <main class="page">
    <header class="masthead">
      <h1>电梯与楼层导向铭牌 · 触觉版预检</h1>
      <p class="subtitle">压点前逐方核对点号组合、数字符（3456）与换行；全部计算在本机浏览器完成，不请求在线转换接口。</p>
    </header>

    <div class="mode-switch" role="tablist" aria-label="预检模式">
      <button
        type="button"
        role="tab"
        class="mode-btn"
        :class="{ active: mode === 'single' }"
        :aria-selected="mode === 'single'"
        data-testid="mode-single"
        @click="mode = 'single'"
      >
        单稿预检
      </button>
      <button
        type="button"
        role="tab"
        class="mode-btn"
        :class="{ active: mode === 'calibration' }"
        :aria-selected="mode === 'calibration'"
        data-testid="mode-calibration"
        @click="mode = 'calibration'"
      >
        试压校准
      </button>
      <button
        type="button"
        role="tab"
        class="mode-btn"
        :class="{ active: mode === 'compare' }"
        :aria-selected="mode === 'compare'"
        data-testid="mode-compare"
        @click="mode = 'compare'"
      >
        双稿核对
      </button>
      <button
        type="button"
        role="tab"
        class="mode-btn"
        :class="{ active: mode === 'training' }"
        :aria-selected="mode === 'training'"
        data-testid="mode-training"
        @click="mode = 'training'"
      >
        识读训练
      </button>
    </div>

    <template v-if="mode === 'single'">
      <section class="panel input-panel" aria-label="制版输入">
        <label class="field">
          <span class="field-label">制版短句</span>
          <textarea
            v-model="phrase"
            rows="3"
            spellcheck="false"
            placeholder="允许：一二三四五六七八九零、半角数字、空格、“，”“。”“-”"
            data-testid="phrase-input"
            :class="{ 'input-invalid': phraseInvalid }"
            :aria-invalid="phraseInvalid"
            :aria-describedby="phraseInvalid ? 'single-errors' : undefined"
          ></textarea>
        </label>

        <div class="field-row">
          <label class="field field-width">
            <span class="field-label">每行方数（{{ MIN_WIDTH }}–{{ MAX_WIDTH }} 方）</span>
            <input
              v-model="widthInput"
              type="number"
              :min="MIN_WIDTH"
              :max="MAX_WIDTH"
              step="1"
              inputmode="numeric"
              data-testid="width-input"
              :class="{ 'input-invalid': widthInvalid }"
              :aria-invalid="widthInvalid"
              :aria-describedby="widthInvalid ? 'single-errors' : undefined"
            />
          </label>
          <div class="width-quick" role="group" aria-label="快速选择每行方数">
            <button
              v-for="choice in widthChoices"
              :key="choice"
              type="button"
              class="quick-btn"
              :class="{ active: widthInput === String(choice) }"
              :aria-pressed="widthInput === String(choice)"
              :aria-label="`每行 ${choice} 方`"
              @click="widthInput = String(choice)"
            >
              {{ choice }}
            </button>
          </div>
        </div>
      </section>

      <section v-if="plan.errors.length > 0" id="single-errors" class="panel errors" role="alert" data-testid="errors">
        <h2>已阻止全部输出</h2>
        <ul>
          <li v-for="(error, i) in plan.errors" :key="i">{{ error }}</li>
        </ul>
      </section>

      <section v-else-if="hasOutput" class="panel preview" data-testid="preview" aria-label="逐方预览">
        <h2>逐方预览（每行 {{ plan.width }} 方）</h2>
        <div v-for="line in plan.lines" :key="line.index" class="plate-line" data-testid="plate-line">
          <span class="line-no">第 {{ line.index }} 行</span>
          <ol class="cells">
            <li v-for="(cell, cellIndex) in line.cells" :key="cellIndex" class="cell-item">
              <CellView :cell="cell" />
            </li>
          </ol>
        </div>
        <p class="total" data-testid="total-cells">总方数：{{ plan.totalCells }} 方（共 {{ plan.lines.length }} 行，末行不补齐）</p>
      </section>

      <!-- 放行闸门始终展示：非法文字 / 行宽或无当前合格判定时逐项列出阻断原因 -->
      <ReleasePanel :text="phrase" :width="widthInput" :live="liveCalibration" />
    </template>

    <template v-else-if="mode === 'compare'">
      <section class="panel compare-input" aria-label="双稿核对输入">
        <div class="draft-row">
          <label class="field">
            <span class="field-label">审核稿（基准）</span>
            <textarea
              v-model="baseDraft"
              rows="3"
              spellcheck="false"
              placeholder="粘贴审核稿短句"
              data-testid="base-input"
            ></textarea>
            <ul v-if="baseErrors.length > 0" class="draft-errors" role="alert" data-testid="base-errors">
              <li v-for="(error, i) in baseErrors" :key="i">{{ error.message }}</li>
            </ul>
          </label>

          <label class="field">
            <span class="field-label">制版稿（待核）</span>
            <textarea
              v-model="targetDraft"
              rows="3"
              spellcheck="false"
              placeholder="粘贴制版稿短句"
              data-testid="target-input"
            ></textarea>
            <ul v-if="targetErrors.length > 0" class="draft-errors" role="alert" data-testid="target-errors">
              <li v-for="(error, i) in targetErrors" :key="i">{{ error.message }}</li>
            </ul>
          </label>
        </div>

        <button type="button" class="compare-btn" data-testid="compare-button" @click="runCompare">发起核对</button>
      </section>

      <section v-if="identicalResult" class="panel compare-identical" role="status" data-testid="compare-identical">
        <h2>核对结论：两稿完全一致</h2>
        <p>审核稿与制版稿编码后的方序列逐项相同，共 {{ identicalResult.cells.length }} 方，无插入、删除或替换。</p>
      </section>

      <section v-else-if="differentResult" class="panel compare-diff" aria-label="双稿差异记录" data-testid="compare-diff">
        <h2>核对结论：存在差异</h2>
        <p class="diff-summary" data-testid="diff-summary">
          首个差异位于第 {{ differentResult.firstDiffIndex + 1 }} 项；共插入 {{ diffCounts.insert }} 方、删除
          {{ diffCounts.delete }} 方、替换 {{ diffCounts.replace }} 方。
        </p>
        <table class="diff-table">
          <thead>
            <tr>
              <th scope="col">项</th>
              <th scope="col">操作</th>
              <th scope="col">审核稿（基准）</th>
              <th scope="col">制版稿（待核）</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(entry, entryIndex) in differentResult.entries"
              :key="entryIndex"
              class="diff-entry"
              :class="[`op-${entry.op}`, { 'is-first-diff': entryIndex === differentResult.firstDiffIndex }]"
              :data-op="entry.op"
              data-testid="diff-entry"
            >
              <td class="diff-no">{{ entryIndex + 1 }}</td>
              <td class="diff-op-cell">
                <span class="diff-op" :class="`op-${entry.op}`">{{ OP_LABELS[entry.op] }}</span>
                <em v-if="entryIndex === differentResult.firstDiffIndex" class="first-diff-tag">首个差异</em>
              </td>
              <td class="diff-side">
                <template v-if="entry.base">
                  <CellView :cell="entry.base.cell" />
                  <span class="source">审核稿第 {{ entry.base.sourceIndex + 1 }} 字</span>
                </template>
                <span v-else class="no-cell">—</span>
              </td>
              <td class="diff-side">
                <template v-if="entry.target">
                  <CellView :cell="entry.target.cell" />
                  <span class="source">制版稿第 {{ entry.target.sourceIndex + 1 }} 字</span>
                </template>
                <span v-else class="no-cell">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <template v-else-if="mode === 'calibration'">
      <CalibrationWorkspace :session="calibrationSession" @live-change="onCalibrationLiveChange" />
    </template>

    <TrainingWorkspace v-if="mode === 'training'" />
  </main>
</template>
