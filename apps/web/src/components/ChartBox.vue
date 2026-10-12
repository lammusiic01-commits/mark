<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, GaugeChart, ScatterChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent, DatasetComponent, MarkLineComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

echarts.use([BarChart, LineChart, PieChart, GaugeChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, DatasetComponent, MarkLineComponent, CanvasRenderer]);

const props = withDefaults(defineProps<{ option: EChartsOption; height?: number | string }>(), { height: 260 });

const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

const THEME_COLORS = ['#2563eb', '#0ea5e9', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#f472b6'];

function baseOption(option: EChartsOption): EChartsOption {
  return {
    color: THEME_COLORS,
    textStyle: { color: '#9aa8c7', fontFamily: 'Inter, system-ui, sans-serif' },
    grid: { left: 8, right: 12, top: 30, bottom: 6, containLabel: true },
    tooltip: { trigger: 'axis', backgroundColor: '#111a2e', borderColor: '#22304f', textStyle: { color: '#e8eefc' } },
    legend: { textStyle: { color: '#9aa8c7' }, top: 0, right: 0, icon: 'roundRect', itemHeight: 8, itemWidth: 12 },
    ...option,
  };
}

function render(): void {
  if (!el.value) return;
  if (!chart) chart = echarts.init(el.value, undefined, { renderer: 'canvas' });
  chart.setOption(baseOption(props.option), true);
}

onMounted(() => {
  render();
  window.addEventListener('resize', resize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  chart?.dispose();
  chart = null;
});

function resize(): void {
  chart?.resize();
}

watch(
  () => props.option,
  () => render(),
  { deep: true },
);

watch(
  () => props.height,
  () => window.setTimeout(resize, 30),
);
</script>

<template>
  <div ref="el" :style="{ height: typeof height === 'number' ? `${height}px` : height, width: '100%' }" />
</template>
