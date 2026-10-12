<script setup lang="ts">
/** Минимальный набор иконок (inline SVG), чтобы не тянуть целую библиотеку. */
const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 });

const PATHS: Record<string, string> = {
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  plug: 'M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6zM12 18v3',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.4 3.9 5.6 3.9 9S14.5 18.6 12 21c-2.5-2.4-3.9-5.6-3.9-9S9.5 5.4 12 3z',
  shield: 'M12 3l7 3v6c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6z',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14',
  chart: 'M4 20V4M4 20h16M8 20v-6M12 20V9M16 20v-9M20 20v-4',
  flask: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l4 2',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3H9.8l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4.4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
  refresh: 'M20 11a8 8 0 1 0-2.3 6M20 5v6h-6',
  check: 'M4 12.5l5 5L20 6.5',
  close: 'M6 6l12 12M18 6L6 18',
  play: 'M7 4l12 8-12 8z',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 4v10M8 11l4 4 4-4M5 19h14',
  trash: 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13',
  bolt: 'M13 2L5 14h6l-1 8 8-12h-6z',
  eye: 'M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21c0-3.6 3.6-6 8-6s8 2.4 8 6',
  copy: 'M9 9h10v12H9zM5 3h10v3H8v12H5z',
  external: 'M14 4h6v6M20 4L10 14M18 14v6H4V6h6',
  robot: 'M9 3h6v2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3zM9 11h.01M15 11h.01M9 16h6M2 12h2M20 12h2',
  fire: 'M12 3c3 4 6 6 6 10a6 6 0 0 1-12 0c0-2 1-3.5 2-5 .3 1.2 1 2 2 2.5C10 8 11 5.5 12 3z',
  filter: 'M3 5h18l-7 8v6l-4-2v-4z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  upload: 'M12 20V8M8 12l4-4 4 4M5 4h14',
  wand: 'M15 4l5 5-11 11H4v-5zM13 6l5 5',
  key: 'M15 3a6 6 0 1 0-5.6 8.2L4 16.6V21h4.4l1-1v-1.6h1.6l1-1v-1.2l.6-.6A6 6 0 0 0 15 3zM16 7h.01',
};

const path = PATHS[props.name] ?? PATHS.grid!;
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="path" />
  </svg>
</template>
