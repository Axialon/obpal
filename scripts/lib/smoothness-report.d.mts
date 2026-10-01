export interface SmoothnessMotion {
  frames: number; motionSeconds: number; motionFrames: number; renderedMotionFrames: number
  p95: number; p99: number; maxGap: number; hidden: number; missingDraws: number; changedGeometry: number
  nonFinite: number; rigidMeshes: number; unsupportedMeshes: number
  physics?: { supported: boolean; maxAngle: number; maxSpeed: number; restJitter: number; invalidFrames: number }
}
export function smoothnessVerdict(result: { warmupFailure?: string | null; error?: string | null; motion?: SmoothnessMotion }): {
  status: 'pass' | 'fail' | 'incomplete'; failures: string[]; gaps: string[]
}
