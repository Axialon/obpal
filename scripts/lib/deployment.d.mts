export const LOCAL_ORIGIN: string
export function guardDeployCheckout(root: string): void
export function publicOrigin(value?: string, opts?: { required?: boolean; https?: boolean }): string
export function liveOrigin(value?: string, env?: Record<string, string | undefined>): string
export interface DeploymentTarget { origin: string; accountId: string }
export interface PublicationTarget { repository: string; authorName: string; authorEmail: string }
export function deploymentTarget(env?: Record<string, string | undefined>): DeploymentTarget
export function guardDeployment(config: Record<string, any>, target: DeploymentTarget): void
export function publicationTarget(env?: Record<string, string | undefined>): PublicationTarget
export function parseJsonc(text: string): any
