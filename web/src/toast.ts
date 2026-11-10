import { useSyncExternalStore } from 'react'

// One short message at a time at the foot of the screen, optionally with one action ("Undo").

export interface Toast {
  id: number
  text: string
  action?: { label: string; run: () => void }
}

let current: Toast | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

export function toast (text: string, action?: Toast['action'], ms = action ? 7000 : 4000): void {
  clearTimeout(timer)
  current = { id: ++seq, text, action }
  emit()
  timer = setTimeout(dismissToast, ms)
}

export function dismissToast (): void {
  clearTimeout(timer)
  current = null
  emit()
}

export const useToast = (): Toast | null => useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => current)
