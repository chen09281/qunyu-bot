<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import charaUrl from '../assets/aemeath.png';

const props = defineProps({
  mode: { type: String, default: 'range' }, // 'range' | 'single'
  modelValue: { type: String, default: '' }, // used when mode === 'single'
  start: { type: String, default: '' },
  end: { type: String, default: '' },
  preset: { type: String, default: 'all' },
  label: { type: String, default: '时间维度' },
  disabled: { type: Boolean, default: false },
  today: { type: String, default: '' }
});

const emit = defineEmits(['update:modelValue', 'update:start', 'update:end', 'update:preset', 'change']);

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

const DIMENSIONS = [
  { id: 'all', label: '全部时间' },
  { id: 'today', label: '今天' },
  { id: '7d', label: '近七天' },
  { id: '30d', label: '30天' },
  { id: 'month', label: '本月' },
  { id: 'last-month', label: '上月' },
  { id: 'custom', label: '自定义' }
];

function getBeijingToday() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

const resolvedToday = computed(() => props.today || getBeijingToday());

function shiftDays(dateStr, deltaDays) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

function getPresetRange(id, baseToday = resolvedToday.value) {
  const [y, m] = baseToday.split('-').map(Number);
  if (id === 'today') return { start: baseToday, end: baseToday };
  if (id === '7d') return { start: shiftDays(baseToday, -6), end: baseToday };
  if (id === '30d') return { start: shiftDays(baseToday, -29), end: baseToday };
  if (id === 'month') return { start: `${baseToday.slice(0, 7)}-01`, end: baseToday };
  if (id === 'last-month') {
    const firstPrev = new Date(Date.UTC(y, (m || 1) - 2, 1)).toISOString().slice(0, 10);
    const lastPrev = new Date(Date.UTC(y, (m || 1) - 1, 0)).toISOString().slice(0, 10);
    return { start: firstPrev, end: lastPrev };
  }
  return { start: '', end: '' };
}

const popoverOpen = ref(false);
const popoverView = ref('list'); // 'list' | 'calendar'
const pickerRef = ref(null);
const pickingPhase = ref('start'); // 'start' | 'end'
const hoverDate = ref('');

function parseYearMonth(dateStr) {
  const [y, m] = String(dateStr || '').split('-').map(Number);
  if (y && m >= 1 && m <= 12) return { year: y, month: m };
  const [ty, tm] = resolvedToday.value.split('-').map(Number);
  return { year: ty || 2026, month: tm || 1 };
}

const initialTarget = props.mode === 'single' ? props.modelValue : (props.end || props.start);
const initialYM = parseYearMonth(initialTarget || resolvedToday.value);
const viewYear = ref(initialYM.year);
const viewMonth = ref(initialYM.month);

watch(
  () => [props.modelValue, props.start, props.end],
  ([singleVal, newStart, newEnd]) => {
    const target = props.mode === 'single' ? singleVal : (newEnd || newStart);
    if (target) {
      const { year, month } = parseYearMonth(target);
      viewYear.value = year;
      viewMonth.value = month;
    }
  }
);

const currentDimension = computed(() => DIMENSIONS.find(item => item.id === props.preset) || DIMENSIONS[0]);

const rangeSummaryText = computed(() => {
  if (props.mode === 'single') return props.modelValue || '选择日期';
  if (!props.start && !props.end) return '全部日期';
  if (props.start && props.end) {
    return props.start === props.end ? props.start : `${props.start.slice(5)} ~ ${props.end.slice(5)}`;
  }
  return props.start ? `${props.start.slice(5)} 起` : `至 ${props.end.slice(5)}`;
});

function formatPresetHint(id) {
  if (id === 'all') return '不限日期';
  if (id === 'custom') return '展开日历';
  const { start, end } = getPresetRange(id);
  return start === end ? start.slice(5) : `${start.slice(5)} ~ ${end.slice(5)}`;
}

function toggleTrigger() {
  if (props.disabled) return;
  if (popoverOpen.value) {
    popoverOpen.value = false;
    return;
  }
  if (props.mode === 'single') {
    popoverView.value = 'calendar';
  } else {
    popoverView.value = props.preset === 'custom' ? 'calendar' : 'list';
  }
  popoverOpen.value = true;
}

function selectDimension(id) {
  emit('update:preset', id);
  if (id === 'custom') {
    const today = resolvedToday.value;
    const nextStart = props.start || shiftDays(today, -6);
    const nextEnd = props.end || today;
    emit('update:start', nextStart);
    emit('update:end', nextEnd);
    const { year, month } = parseYearMonth(nextEnd || nextStart || today);
    viewYear.value = year;
    viewMonth.value = month;
    pickingPhase.value = 'start';
    popoverView.value = 'calendar';
    popoverOpen.value = true;
    emit('change', { preset: id, start: nextStart, end: nextEnd });
    return;
  }
  const { start, end } = getPresetRange(id);
  emit('update:start', start);
  emit('update:end', end);
  pickingPhase.value = 'start';
  popoverOpen.value = false;
  emit('change', { preset: id, start, end });
}

function shiftMonth(delta) {
  const next = new Date(Date.UTC(viewYear.value, viewMonth.value - 1 + delta, 1));
  viewYear.value = next.getUTCFullYear();
  viewMonth.value = next.getUTCMonth() + 1;
}

function selectTodayInCalendar() {
  const today = resolvedToday.value;
  const { year, month } = parseYearMonth(today);
  viewYear.value = year;
  viewMonth.value = month;
  if (props.mode === 'single') {
    emit('update:modelValue', today);
    emit('change', { value: today });
    popoverOpen.value = false;
    return;
  }
  emit('update:preset', 'custom');
  emit('update:start', today);
  emit('update:end', today);
  pickingPhase.value = 'start';
  emit('change', { preset: 'custom', start: today, end: today });
}

function clearCustomDates() {
  if (props.mode === 'single') {
    emit('update:modelValue', resolvedToday.value);
    return;
  }
  emit('update:start', '');
  emit('update:end', '');
  pickingPhase.value = 'start';
  emit('change', { preset: 'custom', start: '', end: '' });
}

const previewRange = computed(() => {
  if (props.mode === 'single') {
    const val = props.modelValue || '';
    return { start: val, end: val };
  }
  if (pickingPhase.value === 'end' && props.start && hoverDate.value) {
    return props.start <= hoverDate.value
      ? { start: props.start, end: hoverDate.value }
      : { start: hoverDate.value, end: props.start };
  }
  const s = props.start || props.end || '';
  const e = props.end || props.start || '';
  if (s && e && s > e) return { start: e, end: s };
  return { start: s, end: e };
});

const calendarCells = computed(() => {
  const year = viewYear.value;
  const month = viewMonth.value;
  const firstDayUtc = new Date(Date.UTC(year, month - 1, 1));
  const startOffset = (firstDayUtc.getUTCDay() + 6) % 7;
  const cells = [];
  const { start, end } = previewRange.value;
  const todayIso = resolvedToday.value;

  for (let i = 0; i < 42; i += 1) {
    const cellDate = new Date(Date.UTC(year, month - 1, 1 - startOffset + i));
    const iso = cellDate.toISOString().slice(0, 10);
    const cellMonth = cellDate.getUTCMonth() + 1;
    const dayNum = cellDate.getUTCDate();
    const isCurrentMonth = cellMonth === month;
    const isStart = Boolean(start && iso === start);
    const isEnd = Boolean(end && iso === end);
    const isInRange = Boolean(start && end && iso > start && iso < end);
    cells.push({
      iso,
      dayNum,
      isCurrentMonth,
      isToday: iso === todayIso,
      isStart,
      isEnd,
      isSingle: isStart && isEnd,
      isInRange
    });
  }
  return cells;
});

function onDayClick(cell) {
  const iso = cell.iso;
  if (!cell.isCurrentMonth) {
    const { year, month } = parseYearMonth(iso);
    viewYear.value = year;
    viewMonth.value = month;
  }
  if (props.mode === 'single') {
    emit('update:modelValue', iso);
    emit('change', { value: iso });
    popoverOpen.value = false;
    return;
  }
  emit('update:preset', 'custom');
  if (pickingPhase.value === 'start' || !props.start) {
    emit('update:start', iso);
    emit('update:end', iso);
    pickingPhase.value = 'end';
    hoverDate.value = iso;
    emit('change', { preset: 'custom', start: iso, end: iso });
    return;
  }
  let nextStart = props.start;
  let nextEnd = iso;
  if (iso < props.start) {
    nextStart = iso;
    nextEnd = props.start;
  }
  emit('update:start', nextStart);
  emit('update:end', nextEnd);
  pickingPhase.value = 'start';
  hoverDate.value = '';
  popoverOpen.value = false;
  emit('change', { preset: 'custom', start: nextStart, end: nextEnd });
}

function handleOutsideInteraction(event) {
  if (!popoverOpen.value) return;
  if (pickerRef.value && !pickerRef.value.contains(event.target)) {
    popoverOpen.value = false;
  }
}

function handleKeydown(event) {
  if (popoverOpen.value && event.key === 'Escape') {
    popoverOpen.value = false;
  }
}

onMounted(() => {
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', handleOutsideInteraction, true);
    document.addEventListener('mousedown', handleOutsideInteraction, true);
    document.addEventListener('focusin', handleOutsideInteraction, true);
    document.addEventListener('keydown', handleKeydown, true);
  }
});

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('pointerdown', handleOutsideInteraction, true);
    document.removeEventListener('mousedown', handleOutsideInteraction, true);
    document.removeEventListener('focusin', handleOutsideInteraction, true);
    document.removeEventListener('keydown', handleKeydown, true);
  }
});
</script>

<template>
  <div class="time-dimension-filter" :class="{ 'is-single-mode': mode === 'single' }">
    <div class="dimension-bar">
      <div class="dimension-field">
        <span v-if="label" class="dimension-label">{{ label }}</span>
        <div ref="pickerRef" class="dimension-select-wrap">
          <button
            type="button"
            class="dimension-trigger"
            :class="{
              open: popoverOpen,
              active: mode === 'single' ? Boolean(modelValue) : preset !== 'all'
            }"
            :disabled="disabled"
            @click="toggleTrigger"
          >
            <template v-if="mode === 'single'">
              <span class="trigger-value">{{ modelValue || '选择日期' }}</span>
              <span class="trigger-range-chip">主题日历</span>
            </template>
            <template v-else>
              <span class="trigger-value">{{ currentDimension.label }}</span>
              <span v-if="preset !== 'all' || start || end" class="trigger-range-chip">{{ rangeSummaryText }}</span>
            </template>
            <svg
              class="trigger-arrow"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 4.5L6 7.5L9 4.5" />
            </svg>
          </button>

          <!-- 1) 时间维度列表浮层（严格等宽于时间维度输入框） -->
          <div
            v-if="popoverOpen && mode === 'range' && popoverView === 'list'"
            class="dimension-dropdown"
            role="listbox"
            aria-label="时间维度选择"
          >
            <button
              v-for="item in DIMENSIONS"
              :key="item.id"
              type="button"
              role="option"
              class="dimension-option"
              :class="{ active: preset === item.id }"
              :aria-selected="preset === item.id"
              @click="selectDimension(item.id)"
            >
              <span class="option-main">
                <span class="option-dot"></span>
                <span class="option-label">{{ item.label }}</span>
                <span v-if="item.id === 'custom'" class="option-tag">日历</span>
              </span>
              <span class="option-hint">{{ formatPresetHint(item.id) }}</span>
            </button>
          </div>

          <!-- 2) 主题日历浮层（严格限制在时间维度输入框宽度内，右下角柔光角色立绘） -->
          <div
            v-if="popoverOpen && (mode === 'single' || popoverView === 'calendar')"
            class="compact-calendar-popover"
          >
            <img class="calendar-chara-watermark" :src="charaUrl" alt="" aria-hidden="true" />

            <div class="cal-popover-head">
              <button
                v-if="mode === 'range'"
                type="button"
                class="cal-back-list-btn"
                title="返回时间维度列表"
                @click="popoverView = 'list'"
              >
                ‹ 列表
              </button>
              <div class="cal-month-switcher">
                <button type="button" class="cal-nav-arrow" title="上一月" @click="shiftMonth(-1)">‹</button>
                <span class="cal-month-label">{{ viewYear }}.{{ String(viewMonth).padStart(2, '0') }}</span>
                <button type="button" class="cal-nav-arrow" title="下一月" @click="shiftMonth(1)">›</button>
              </div>
              <span class="cal-range-badge">{{ rangeSummaryText }}</span>
            </div>

            <div class="cal-grid-area" @mouseleave="hoverDate = ''">
              <div class="cal-weekdays">
                <span v-for="day in WEEKDAYS" :key="day">{{ day }}</span>
              </div>
              <div class="cal-days">
                <button
                  v-for="cell in calendarCells"
                  :key="cell.iso"
                  type="button"
                  class="cal-day"
                  :class="{
                    'is-outside': !cell.isCurrentMonth,
                    'is-today': cell.isToday,
                    'is-start': cell.isStart,
                    'is-end': cell.isEnd,
                    'is-single': cell.isSingle,
                    'is-in-range': cell.isInRange
                  }"
                  @mouseenter="hoverDate = cell.iso"
                  @click="onDayClick(cell)"
                >
                  <span>{{ cell.dayNum }}</span>
                  <i v-if="cell.isToday" class="today-mark">今</i>
                </button>
              </div>
            </div>

            <div class="cal-popover-foot">
              <div class="cal-quick-btns">
                <button type="button" class="cal-mini-action" @click="selectTodayInCalendar">今天</button>
                <button
                  v-if="mode === 'range' && (start || end)"
                  type="button"
                  class="cal-mini-action"
                  @click="clearCustomDates"
                >
                  清空
                </button>
              </div>
              <span class="cal-phase-hint">
                {{
                  mode === 'single'
                    ? '点击选择截止日'
                    : pickingPhase === 'end'
                      ? '请再点选结束日'
                      : '北京时间 UTC+8'
                }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <slot />
    </div>
  </div>
</template>

<style scoped>
.time-dimension-filter {
  display: block;
  width: 100%;
}

.dimension-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: flex-end;
}

.dimension-field,
.dimension-bar :deep(label) {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 200px;
  min-width: 0;
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  color: #425675;
}

.dimension-label {
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  color: #425675;
  margin: 0;
}

.dimension-select-wrap {
  position: relative;
  width: 100%;
}

.dimension-trigger,
.dimension-bar :deep(select),
.dimension-bar :deep(input) {
  height: 42px;
  min-height: 42px;
  margin: 0;
  box-sizing: border-box;
  border-radius: 10px;
  border: 1px solid #d8e0ee;
  background-color: #fbfcff;
  color: var(--ink);
  font-size: 13px;
}

.dimension-bar :deep(> button),
.dimension-bar :deep(.filter-actions button) {
  height: 42px;
  min-height: 42px;
  margin: 0;
  box-sizing: border-box;
  font-size: 13px;
}

.dimension-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 0 13px 0 14px;
  text-align: left;
  transition: border-color 0.16s, box-shadow 0.16s, background-color 0.16s;
}

.dimension-trigger:hover:not(:disabled),
.dimension-trigger.open {
  background-color: #ffffff;
  border-color: #8199ce;
  box-shadow: 0 0 0 3px #879bd326;
}

.dimension-trigger.active {
  background: linear-gradient(120deg, #f3f7ff 0%, #f7f3fc 100%);
  border-color: #b8c8eb;
}

.trigger-value {
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
}

.dimension-trigger.active .trigger-value {
  font-weight: 600;
  color: var(--accent);
}

.trigger-range-chip {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 999px;
  background: #eef2fc;
  border: 1px solid #dce4f5;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trigger-arrow {
  margin-left: auto;
  color: #65738b;
  flex-shrink: 0;
  transition: transform 0.18s ease;
}

.trigger-range-chip + .trigger-arrow {
  margin-left: 0;
}

.dimension-trigger.open .trigger-arrow {
  transform: rotate(180deg);
  color: var(--accent);
}

/* 两个浮层均严格等于上方「时间维度」输入框宽度（left: 0; right: 0; width: 100%），绝不越界 */
.dimension-dropdown,
.compact-calendar-popover {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  right: 0;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  z-index: 50;
}

.dimension-dropdown {
  padding: 7px;
  border-radius: 15px;
  border: 1px solid #d5dff4;
  background: linear-gradient(145deg, #ffffff 0%, #f5f8fe 62%, #fbf3fb 100%);
  box-shadow: 0 16px 36px #2d436e24;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dimension-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--ink);
  font-size: 12px;
  text-align: left;
  transition: background 0.14s, border-color 0.14s, color 0.14s;
}

.dimension-option:hover {
  background: #edf3ff;
  border-color: #dce5f9;
}

.dimension-option.active {
  background: linear-gradient(120deg, #e6efff 0%, #f1ebfa 100%);
  border-color: #c6d6f6;
  color: var(--accent);
  font-weight: 700;
}

.option-main {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.option-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: #c5d1ea;
  flex-shrink: 0;
}

.dimension-option.active .option-dot {
  background: var(--accent);
}

.option-tag {
  padding: 1px 6px;
  border-radius: 999px;
  background: linear-gradient(120deg, #4669ac, #8570ba);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
}

.option-hint {
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 方案 A 紧凑悬浮水印立绘日历（严格 100% 输入框宽度） */
.compact-calendar-popover {
  border-radius: 16px;
  border: 1px solid #ced9f2;
  background: linear-gradient(135deg, #eaf1ff 0%, #f2edf9 55%, #fbeaf2 100%);
  box-shadow: 0 18px 40px #2d436e26, inset 0 1px 0 #ffffffdd;
  padding: 11px 12px 10px;
  overflow: hidden;
}

.calendar-chara-watermark {
  position: absolute;
  right: -16px;
  bottom: -18px;
  width: 156px;
  opacity: 0.34;
  pointer-events: none;
  user-select: none;
  z-index: 1;
  filter: saturate(1.05);
}

.cal-popover-head {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 8px;
}

.cal-back-list-btn {
  min-height: 22px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid #d5dff3;
  background: #ffffffcc;
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.cal-back-list-btn:hover {
  background: #ffffff;
  border-color: var(--accent);
}

.cal-month-switcher {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.cal-month-label {
  font-size: 12px;
  font-weight: 700;
  color: #354e7b;
  font-variant-numeric: tabular-nums;
  min-width: 54px;
  text-align: center;
}

.cal-nav-arrow {
  width: 21px;
  height: 21px;
  min-height: 21px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: #ffffffb8;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  display: inline-grid;
  place-items: center;
}

.cal-nav-arrow:hover {
  background: #ffffff;
}

.cal-range-badge {
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 999px;
  background: #ffffffcc;
  border: 1px solid #d5dff4;
  color: var(--accent);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cal-grid-area {
  position: relative;
  z-index: 2;
}

.cal-weekdays,
.cal-days {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 2px;
}

.cal-weekdays {
  margin-bottom: 4px;
  padding-bottom: 4px;
  border-bottom: 1px dashed #d5dff288;
}

.cal-weekdays span {
  text-align: center;
  font-size: 10px;
  font-weight: 700;
  color: #5e6f8f;
}

.cal-day {
  position: relative;
  height: 27px;
  min-height: 27px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: #283751;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s;
}

.cal-day:hover {
  background: #ffffffb5;
  color: var(--accent);
}

.cal-day.is-outside {
  color: #9aa7bf;
  font-weight: 500;
}

.cal-day.is-today {
  border-color: #b7c8ec;
  color: var(--accent);
  font-weight: 700;
}

.cal-day.is-in-range {
  background: #dce7ffbf;
  color: #35528d;
  border-radius: 5px;
}

.cal-day.is-start,
.cal-day.is-end {
  background: linear-gradient(135deg, #4669ac 0%, #7d6bb8 100%);
  color: #ffffff;
  border-color: transparent;
  box-shadow: 0 2px 6px #4669ac38;
}

.today-mark {
  position: absolute;
  top: 1px;
  right: 2px;
  font-style: normal;
  font-size: 8px;
  line-height: 1;
  color: #7d6bb8;
}

.cal-day.is-start .today-mark,
.cal-day.is-end .today-mark {
  color: #ffffff;
}

.cal-popover-foot {
  position: relative;
  z-index: 2;
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid #d8e1f580;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.cal-quick-btns {
  display: inline-flex;
  gap: 4px;
}

.cal-mini-action {
  min-height: 22px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid #d5dff3;
  background: #ffffffcc;
  color: var(--accent);
  font-size: 10px;
  font-weight: 600;
}

.cal-mini-action:hover {
  background: #ffffff;
  border-color: var(--accent);
}

.cal-phase-hint {
  font-size: 10px;
  color: #627392;
  white-space: nowrap;
}
</style>
