<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import PermitSnapshot from './PermitSnapshot.vue';
import {
  evaluateGate,
  isPermitCurrent,
  issueReleasePermit,
  type LiveCalibration,
  type ReleasePermit
} from '../lib/release';
import {
  RELEASE_STORAGE_KEY,
  appendReleasePermit,
  loadReleaseStore
} from '../lib/releaseStorage';

/**
 * 压点放行面板（挂在单稿预检工作区内）。
 *
 * 闸门只在“当前屏幕上的合法单稿 + 本次新完成的合格判定”同时成立时放行；
 * 放行单一经签发即为不可变快照，文字、行宽或任一点读数被改动后当前授权
 * 立即失效，但历史放行单始终只读可复核，绝不会被草稿覆盖。
 */
const props = defineProps<{
  text: string;
  width: string | number;
  live: LiveCalibration;
}>();

const gate = computed(() => evaluateGate(props.text, props.width, props.live));

const initial = loadReleaseStore();
const permits = ref<ReleasePermit[]>(initial.permits.slice());
const archiveWarning = ref(initial.warning?.message ?? null);
const writeError = ref<string | null>(null);

/** 最近一次在本会话签发的放行单标识；其是否仍为当前授权另行实时核对。 */
const lastIssuedId = ref<string | null>(null);

const lastIssuedPermit = computed(() => {
  if (lastIssuedId.value === null) {
    return null;
  }
  return permits.value.find((permit) => permit.id === lastIssuedId.value) ?? null;
});

const currentPermit = computed(() => {
  const permit = lastIssuedPermit.value;
  if (!permit) {
    return null;
  }
  return isPermitCurrent(permit, props.text, props.width, props.live) ? permit : null;
});

/** 已签发但当前授权已失效（文字、行宽或任一点读数被改动）。 */
const invalidated = computed(() => lastIssuedPermit.value !== null && currentPermit.value === null);

// 历史单按签发时间倒序展示，最新的在最上面。
const historyPermits = computed(() => permits.value.slice().sort((a, b) => b.issuedAt - a.issuedAt));

const pointIndices = [0, 1, 2, 3, 4, 5];

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '存档恢复（时间未记录）';
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function issue() {
  if (!gate.value.releasable || !gate.value.draft) {
    return;
  }
  const permit = issueReleasePermit(gate.value.draft, props.live);
  const appended = appendReleasePermit(permit, permits.value);
  permits.value = appended.permits.slice();
  lastIssuedId.value = permit.id;
  if (appended.ok) {
    writeError.value = null;
    archiveWarning.value = null;
  } else {
    writeError.value = appended.warning?.message ?? '放行单写入失败，已保留最近一次完整记录。';
  }
}

/**
 * 跨标签页收到放行存档更新：只接受完整、版本相符、逐单可复算的记录，
 * 合并内存中尚未落盘的放行单（写入失败时保留的最近一次完整记录）。
 * 磁盘上内容相同的同标识记录视为同一不可变单，直接以磁盘为准，避免误报冲突。
 * 不会把任何旧单自动当作当前授权——当前身份仍按屏幕内容实时核对。
 */
function onStorage(event: StorageEvent) {
  if (event.storageArea !== window.localStorage || event.key !== RELEASE_STORAGE_KEY) {
    return;
  }
  const store = loadReleaseStore();
  const byId = new Map<string, ReleasePermit>(store.permits.map((permit) => [permit.id, permit]));
  for (const permit of permits.value) {
    if (!byId.has(permit.id)) {
      byId.set(permit.id, permit);
    }
  }
  permits.value = Array.from(byId.values()).sort((a, b) => a.issuedAt - b.issuedAt || a.id.localeCompare(b.id));
  archiveWarning.value = store.warning?.message ?? null;
}
window.addEventListener('storage', onStorage);
onBeforeUnmount(() => {
  window.removeEventListener('storage', onStorage);
});
</script>

<template>
  <section class="panel release-gate" data-testid="release-gate" aria-label="压点放行闸门">
    <h2>压点放行</h2>
    <p v-if="gate.releasable" class="release-can-release" data-testid="release-can-release" role="status">
      单稿预检通过，且六点试压为本次新完成的“合格”判定：可以签发放行单。
    </p>
    <ul v-else class="release-reasons" data-testid="release-gate-reasons">
      <li v-for="(message, index) in gate.messages" :key="index" data-testid="release-gate-reason">{{ message }}</li>
    </ul>
    <button
      type="button"
      class="compare-btn release-issue"
      data-testid="release-issue"
      :disabled="!gate.releasable"
      @click="issue"
    >
      签发压点放行单
    </button>
  </section>

  <section
    v-if="archiveWarning"
    class="panel errors release-archive-warning"
    role="alert"
    data-testid="release-archive-warning"
  >
    <h2>放行单存档告警</h2>
    <p>{{ archiveWarning }}</p>
  </section>

  <section
    v-if="writeError"
    class="panel errors release-storage-error"
    role="alert"
    data-testid="release-storage-error"
  >
    <h2>放行单写入失败</h2>
    <p>{{ writeError }}</p>
  </section>

  <section
    v-if="currentPermit"
    class="panel release-current"
    data-testid="release-current"
    aria-label="当前放行授权"
  >
    <h2>当前放行单（授权有效）</h2>
    <p class="release-id" data-testid="release-current-id">放行单号：{{ currentPermit.id }}</p>
    <p class="release-time">签发时间：{{ formatTime(currentPermit.issuedAt) }}</p>
    <PermitSnapshot :permit="currentPermit" :point-indices="pointIndices" />
  </section>

  <section
    v-else-if="invalidated && lastIssuedPermit"
    class="panel release-invalidated"
    data-testid="release-invalidated"
    role="alert"
  >
    <h2>当前可放行状态已失效</h2>
    <p>
      放行单 <strong data-testid="release-invalidated-id">{{ lastIssuedPermit.id }}</strong>
      签发后，文字、行宽或某一点读数已被改动，当前不再具备放行授权；该单作为历史记录仍可只读复核，
      需重新完成“合格”判定后签发新单。
    </p>
  </section>

  <section v-if="historyPermits.length > 0" class="panel release-history" aria-label="历史放行单复核">
    <h2>历史放行单（只读复核，不可修改）</h2>
    <article
      v-for="permit in historyPermits"
      :key="permit.id"
      class="release-permit"
      :class="{ 'is-current': currentPermit?.id === permit.id }"
      :data-permit-id="permit.id"
      data-testid="release-permit"
    >
      <header class="release-permit-head">
        <span class="release-id" data-testid="release-permit-id">{{ permit.id }}</span>
        <span v-if="currentPermit?.id === permit.id" class="release-badge-current">当前授权</span>
        <span v-else class="release-badge-history">历史存档</span>
        <span class="release-time">签发于 {{ formatTime(permit.issuedAt) }}</span>
      </header>
      <PermitSnapshot :permit="permit" :point-indices="pointIndices" />
    </article>
  </section>
</template>
