/** Three finished renders at the same shader and texture counts before a scene's first appearance. */
export class SceneWarmup {
  private programs = -1
  private textures = -1
  private stable = 0
  private revealed = false

  frame(ready: boolean, programs: number, textures: number): boolean {
    if (this.revealed) return true
    if (!ready || programs !== this.programs || textures !== this.textures) this.stable = 0
    this.programs = programs
    this.textures = textures
    if (ready && ++this.stable >= 3) this.revealed = true
    return this.revealed
  }
}
