<script setup lang="ts">
import Icon from './Icon.vue';

withDefaults(defineProps<{ title: string; message?: string; icon?: string }>(), { icon: 'list' });
</script>

<template>
  <div class="empty">
    <Icon :name="icon" :size="30" />
    <h3 style="margin-top: 8px">{{ title }}</h3>
    <p v-if="message" class="small muted" style="max-width: 560px; margin: 0 auto 12px">{{ message }}</p>
    <slot />
  </div>
</template>
