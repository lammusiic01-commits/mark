import { ref } from 'vue';
import { success as hapticSuccess, failure as hapticFailure } from './telegram';

/**
 * Всплывающие подсказки мини-приложения.
 * Одновременно с показом срабатывает тактильный отклик — так пользователь
 * чувствует результат действия, даже не глядя на экран.
 */

export interface MiniToast {
  id: string;
  variant: 'success' | 'error' | 'info';
  title: string;
  message?: string;
}

export const toasts = ref<MiniToast[]>([]);

export function dismiss(id: string): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

export function showToast(variant: MiniToast['variant'], title: string, message?: string): void {
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  toasts.value = [...toasts.value.slice(-2), { id, variant, title, message }];
  if (variant === 'success') hapticSuccess();
  if (variant === 'error') hapticFailure();
  window.setTimeout(() => dismiss(id), variant === 'error' ? 5200 : 3200);
}

export const toastOk = (title: string, message?: string): void => showToast('success', title, message);
export const toastErr = (title: string, message?: string): void => showToast('error', title, message);
export const toastInfo = (title: string, message?: string): void => showToast('info', title, message);

/** Обёртка асинхронного действия: показывает ошибку и не ломает интерфейс. */
export async function guard<T>(action: () => Promise<T>, title = 'Не получилось'): Promise<T | null> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toastErr(title, message);
    return null;
  }
}
