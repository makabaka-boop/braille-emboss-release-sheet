<script setup lang="ts">
import CellView from './CellView.vue';
import { permitHeightText, type ReleasePermit } from '../lib/release';

defineProps<{
  permit: ReleasePermit;
  pointIndices: number[];
}>();

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '存档恢复（时间未记录）';
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <div class="permit-snapshot" data-testid="permit-snapshot">
    <dl class="permit-meta">
      <dt>单稿原文</dt>
      <dd data-testid="permit-text">{{ permit.draft.text }}</dd>
      <dt>行宽</dt>
      <dd data-testid="permit-width">每行 {{ permit.draft.width }} 方</dd>
      <dt>逐方编码</dt>
      <dd class="permit-cells" data-testid="permit-cells">
        <ol class="cells">
          <li v-for="(cell, index) in permit.draft.cells" :key="index" class="cell-item">
            <CellView :cell="cell" />
          </li>
        </ol>
      </dd>
      <dt>总方数</dt>
      <dd>{{ permit.draft.totalCells }} 方（共 {{ permit.draft.lines.length }} 行，末行不补齐）</dd>
      <dt>校准判定时间</dt>
      <dd>{{ formatTime(permit.calibration.judgedAt) }}</dd>
    </dl>

    <table class="permit-points" data-testid="permit-points">
      <thead>
        <tr>
          <th scope="col">点位</th>
          <th scope="col">固化原始读数</th>
          <th scope="col">实测值（毫米）</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="index in pointIndices" :key="index" :data-testid="`permit-reading-${index + 1}`">
          <td>{{ index + 1 }} 号点</td>
          <td>{{ permit.calibration.readings[index] }}</td>
          <td>{{ permitHeightText(permit, index) }}</td>
        </tr>
      </tbody>
    </table>

    <p class="permit-conclusion" data-testid="permit-conclusion">{{ permit.calibration.conclusion }}</p>

    <div class="permit-lines" data-testid="permit-lines">
      <div v-for="(line, lineIndex) in permit.draft.lines" :key="lineIndex" class="plate-line" data-testid="permit-line">
        <span class="line-no">第 {{ lineIndex + 1 }} 行</span>
        <ol class="cells">
          <li v-for="(cell, cellIndex) in line" :key="cellIndex" class="cell-item">
            <CellView :cell="cell" />
          </li>
        </ol>
      </div>
    </div>
  </div>
</template>
