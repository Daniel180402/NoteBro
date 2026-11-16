import type { NoteBroApi } from './index'

declare global {
  interface Window {
    notebro: NoteBroApi
  }
}
