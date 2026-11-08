/**
 * shadcn-vue 基础工具：cn() —— clsx + tailwind-merge。
 * 合并 Tailwind 类时后者覆盖前者（twMerge 解决冲突类）。
 */
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
