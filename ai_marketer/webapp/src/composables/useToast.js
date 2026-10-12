/*
  Всплывающие сообщения. Хранятся в общем состоянии приложения, поэтому
  показать сообщение можно из любого экрана одной строкой:

      const toast = useToast()
      toast.success('Кампания включена')
*/
import { computed } from 'vue'
import { useAppStore } from '../store'
import { useHaptics } from './useHaptics'

export function useToast() {
  const store = useAppStore()
  const haptics = useHaptics()

  return {
    items: computed(() => store.toasts),

    show(text, kind = 'info') {
      if (kind === 'success') haptics.success()
      else if (kind === 'error') haptics.error()
      else haptics.soft()
      store.pushToast(text, kind)
    },

    success: (text) => {
      haptics.success()
      store.pushToast(text, 'success')
    },
    error: (text) => {
      haptics.error()
      store.pushToast(text, 'error')
    },
    info: (text) => {
      haptics.soft()
      store.pushToast(text, 'info')
    },

    close: (id) => store.dropToast(id),
  }
}
