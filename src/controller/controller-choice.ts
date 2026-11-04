import type { ControllerId } from '@obpal/core'
import type { Rating } from './ratings'

/** The active screen's explicit choice. Recommendations never select a controller or start input. */
export class ControllerChoice {
  private screen = ''
  private selected: ControllerId | null = null

  connect(screen: string) {
    if (screen !== this.screen) this.selected = null
    this.screen = screen
  }

  clear() { this.selected = null }

  current(ratings: readonly Rating[]): ControllerId | null {
    if (!ratings.some(r => r.id === this.selected && r.fit > 0)) this.selected = null
    return this.selected
  }

  pick(id: ControllerId, ratings: readonly Rating[]): boolean {
    if (!this.screen || !ratings.some(r => r.id === id && r.fit > 0)) return false
    this.selected = id
    return true
  }
}
