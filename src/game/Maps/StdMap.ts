/**
 * The JavaScript `Map` (the C++ `std::map` / `std::unordered_map`) under a name that does not clash with the `Map` class
 * of `Map.ts`. Modules that import the game `Map` class use this for their own dictionaries.
 */
export const StdMap = globalThis.Map;
export type StdMap<K, V> = Map<K, V>;
export type StdReadonlyMap<K, V> = ReadonlyMap<K, V>;
