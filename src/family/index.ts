/**
 * Typed access to the shared Blackboxes family design system (vendored from the BlackBoxes repo, shared/family/;
 * refresh with `pnpm run sync:family`). family.js is a classic script that defines window.BlackboxesFamily.
 */
import './family.css'
import './family.js'

export type FamilyThemeId = 'carbon' | 'navy' | 'violet' | 'wine' | 'onyx' | 'light'
export interface FamilyProduct { id: string; name: string; category: string; host: string; accent: string }
export interface FamilyTheme { id: FamilyThemeId; name: string; page: string; surface: string; light: boolean }
export interface FamilyAccent { id: string; name: string; color?: string }
interface Popover { open(): void; close(): void; toggle(): void }

export interface FamilyApi {
  PRODUCTS: FamilyProduct[]
  THEMES: FamilyTheme[]
  ACCENTS: FamilyAccent[]
  DEFAULT_THEME: FamilyThemeId
  getTheme(): FamilyThemeId
  setTheme(id: string): FamilyThemeId
  applyTheme(id?: string): FamilyThemeId
  watchTheme(): void
  setProduct(id: string): void
  product(): FamilyProduct
  /** 'product' (the site's own colour, the default) or an accent id. Remembered per site. */
  getAccent(): string
  setAccent(id: string): string
  applyAccent(id?: string): string
  /** The accent in effect as a hex colour. */
  accentColor(): string
  mark(productId: string, opts?: { accent?: string; title?: boolean }): string
  productMenu(current: string): string
  themeMenu(): string
  popover(button: HTMLElement, menu: HTMLElement, onOpen?: (menu: HTMLElement) => void): Popover
  mountSwitcher(button: HTMLElement, menu: HTMLElement, current: string): Popover
  mountThemes(button: HTMLElement, menu: HTMLElement): Popover
  mountMore(button: HTMLElement, menu: HTMLElement, toolsRoot: HTMLElement): Popover
  initTips(): void
  hint(id: string, anchor: () => Element | null, text: string, opts?: { place?: 'above' | 'below'; delay?: number }): void
  dismissHint(id: string, silent?: boolean): void
  icons: { chevron: string; check: string }
  /** Refresh the accent fill of one .bb-range, or of every .bb-range under root. */
  rangeFill(el: HTMLInputElement): void
  syncRanges(root?: ParentNode): void
}

declare global {
  interface Window { BlackboxesFamily: FamilyApi }
}

export const family: FamilyApi = window.BlackboxesFamily
