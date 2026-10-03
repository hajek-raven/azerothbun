/**
 * Port of `common/Dynamic/ObjectRegistry.h`: holds all registry items of the same type, keyed by `Key`.
 *
 * The C++ is a template with a per instantiation `instance()` singleton. TypeScript has no per instantiation statics, so
 * the owner of a registry (for movement generators: `MovementGenerator.ts`) creates the single instance and exports it.
 */
export class ObjectRegistry<T, Key = string> {
  private readonly _registeredObjects = new Map<Key, T>();

  /** Returns a registry item. @ac common/Dynamic/ObjectRegistry.h ObjectRegistry::GetRegistryItem */
  getRegistryItem(key: Key): T | null {
    return this._registeredObjects.get(key) ?? null;
  }

  /** Inserts a registry item. @ac common/Dynamic/ObjectRegistry.h ObjectRegistry::InsertItem */
  insertItem(obj: T, key: Key, force = false): boolean {
    if (this._registeredObjects.has(key)) {
      if (!force) return false;
      this._registeredObjects.delete(key);
    }

    this._registeredObjects.set(key, obj);
    return true;
  }

  /** Returns true if registry contains an item. @ac common/Dynamic/ObjectRegistry.h ObjectRegistry::HasItem */
  hasItem(key: Key): boolean {
    return this._registeredObjects.has(key);
  }

  /** Return the map of registered items. @ac common/Dynamic/ObjectRegistry.h ObjectRegistry::GetRegisteredItems */
  getRegisteredItems(): ReadonlyMap<Key, T> {
    return this._registeredObjects;
  }
}
