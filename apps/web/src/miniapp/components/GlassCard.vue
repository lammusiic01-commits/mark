<script setup lang="ts">
/** Стеклянная карточка — базовая поверхность всего приложения. */
withDefaults(defineProps<{ pad?: boolean; tight?: boolean }>(), { pad: true, tight: false });
</script>

<template>
  <section class="glass" :class="{ 'glass-pad': pad && !tight, 'glass-tight': tight }">
    <slot />
  </section>
</template>
