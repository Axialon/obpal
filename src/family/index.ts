import { html, setMarkup, type Content } from '../ui/markup'
/**
 * Typed access to the shared Blackboxes family design system (vendored from the BlackBoxes repo, shared/family/;
 * refresh with `pnpm run sync:family`). family.js is a classic script that defines window.BlackboxesFamily.
 */
import './family.css'
import './family.js'
import { fitControlInk } from '../ui/kit/ink'
import { mountDotLoaders } from '../ui/kit/loading'

mountDotLoaders()

// All product surfaces share the same glyph fitting, including controls mounted after pairing or opening a sheet.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => fitControlInk(), { once: true })
else fitControlInk()

export type FamilyThemeId = 'carbon' | 'navy' | 'violet' | 'wine' | 'onyx' | 'light'
export interface FamilyProduct { id: string; name: string; category: string; host: string; accent: string }
export interface FamilyTheme { id: FamilyThemeId; name: string; page: string; surface: string; light: boolean }
export interface FamilyAccent { id: string; name: string; color?: string }
interface Popover { open(): void; close(): void; toggle(): void; place(): void }
/** Optional placement for an edge tray or another host with its own reserved screen space. */
export type MenuPlacement = (menu: HTMLElement, button: HTMLElement) => void

export interface SwitcherOptions { href?: (product: FamilyProduct) => string; itemClass?: string }

export interface FamilyApi {
  /** Adapt the shared templates to this product's Trusted Types policy. */
  configure(options: { markup?: { html: typeof html; setMarkup: typeof setMarkup }; reactiveRanges?: boolean }): void
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
  mark(productId: string, opts?: { accent?: string; title?: boolean }): Content
  /** opts.href(product): a site's own link for a product (a local preview); opts.itemClass: a class for each item. */
  productMenu(current: string, opts?: SwitcherOptions): Content
  themeMenu(): Content
  popover(button: HTMLElement, menu: HTMLElement, onOpen?: (menu: HTMLElement) => void, place?: MenuPlacement): Popover
  mountSwitcher(button: HTMLElement, menu: HTMLElement, current: string, opts?: SwitcherOptions): Popover
  mountThemes(button: HTMLElement, menu: HTMLElement, place?: MenuPlacement): Popover
  mountMore(button: HTMLElement, menu: HTMLElement, toolsRoot: HTMLElement): Popover
  initTips(): void
  hint(id: string, anchor: () => Element | null, text: string, opts?: { place?: 'above' | 'below'; delay?: number }): void
  dismissHint(id: string, silent?: boolean): void
  icons: { chevron: string; check: string }
  /** The filled share (0 to 1) of a slider at `value` between `min` and `max`: clamped; an empty range is empty. */
  rangeShare(value: number, min: number, max: number): number
  /**
   * Refresh the accent fill of one .bb-range, or of every .bb-range under root. Rarely needed: a slider refills
   * itself when it arrives, is dragged, or has its value or bounds set in code.
   */
  rangeFill(el: HTMLInputElement): void
  syncRanges(root?: ParentNode): void
}

declare global {
  interface Window { BlackboxesFamily: FamilyApi }
}

export const family: FamilyApi = window.BlackboxesFamily
family.configure({ markup: { html, setMarkup }, reactiveRanges: true })
