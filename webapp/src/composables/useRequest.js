import { ref } from 'vue'

/** Состояние запроса: data, loading, error и run(...args) */
export function useRequest(fn) {
  const data = ref(null)
  const loading = ref(false)
  const error = ref('')

  async function run(...args) {
    loading.value = true
    error.value = ''
    try {
      data.value = await fn(...args)
    } catch (e) {
      error.value = e.message || 'Неизвестная ошибка'
    } finally {
      loading.value = false
    }
    return data.value
  }

  return { data, loading, error, run }
}
