interface Item { src: string; kind: string; x: number; y: number; width: number; height?: number; cropCss?: number[]; label?: string }
interface Scene { scene: string; face?: string; title: string; sub: string; items: Item[] }
export const SHOTS: Scene[]
export const POSTERS: Record<string, { phone: string; title: string; sub?: string }>
