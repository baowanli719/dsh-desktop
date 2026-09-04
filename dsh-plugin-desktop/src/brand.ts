/**
 * Process-local brand holder shared by every Desktop copy resolver.
 *
 * The brand is a single-language server-delivered value: the same name and
 * headline apply to every locale. This module stays free of Node imports so
 * the native-window bundles (login, recovery, setup wizard) can resolve copy
 * against the built-in defaults while the main-process brand store
 * (`server/gs-brand.ts`) keeps the holder in sync.
 */

/** Effective brand copy: server value, local cache, or the built-in default. */
export interface GsBrand {
  readonly name: string
  readonly headline: string
}

/** Built-in brand used before the server or the local cache speaks. */
export const GS_BRAND_DEFAULT: GsBrand = Object.freeze({
  name: '办公 Agent',
  headline: '探索未至之境',
})

/** Placeholder embedded in copy dictionaries and replaced with the brand name. */
export const BRAND_PLACEHOLDER = '{brand}'

let current: GsBrand = GS_BRAND_DEFAULT

/** Latest effective brand; the built-in default until the brand store loads. */
export function currentBrand(): GsBrand {
  return current
}

/** Store-owned holder update; copy resolvers never call this directly. */
export function setCurrentBrand(brand: GsBrand): void {
  current = brand
}

/**
 * Deep-resolve the `{brand}` placeholder in one copy dictionary: plain strings
 * are replaced in place, function-valued entries are wrapped so their results
 * are replaced, and nested records are mapped recursively.
 */
export function interpolateBrand<T>(template: T, brand: string): T {
  if (typeof template === 'string') return template.replaceAll(BRAND_PLACEHOLDER, brand) as T
  if (typeof template === 'function') {
    return ((...args: unknown[]) => interpolateBrand(
      (template as (...args: unknown[]) => unknown)(...args),
      brand,
    )) as T
  }
  if (typeof template === 'object' && template !== null && !Array.isArray(template)) {
    const resolved: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(template)) resolved[key] = interpolateBrand(value, brand)
    return resolved as T
  }
  return template
}
