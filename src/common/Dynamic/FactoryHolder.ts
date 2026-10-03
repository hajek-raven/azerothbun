/**
 * Port of `common/Dynamic/FactoryHolder.h`: a `FactoryHolder` holds a factory object of a specific type.
 *
 * `FactoryHolderRegistry::instance()` (one `ObjectRegistry` per `<T, O, Key>` instantiation) is passed to the constructor
 * by the concrete factory family (see `MovementGeneratorCreator`).
 */
import { ObjectRegistry } from "./ObjectRegistry.ts";

/** @ac common/Dynamic/FactoryHolder.h FactoryHolder */
export abstract class FactoryHolder<T, O, Key = string> {
  /** @ac common/Dynamic/FactoryHolder.h FactoryHolder::_key */
  private readonly _key: Key;

  /** @ac common/Dynamic/FactoryHolder.h FactoryHolder::FactoryHolder */
  constructor(
    private readonly _registry: ObjectRegistry<FactoryHolder<T, O, Key>, Key>,
    k: Key,
  ) {
    this._key = k;
  }

  /** @ac common/Dynamic/FactoryHolder.h FactoryHolder::RegisterSelf */
  registerSelf(): void {
    this._registry.insertItem(this, this._key);
  }

  /** Abstract Factory create method. @ac common/Dynamic/FactoryHolder.h FactoryHolder::Create */
  abstract create(object?: O | null): T;
}

/**
 * Permissible is a classic way of letting the object decide whether how good they handle things. This is not restricted
 * to factory selectors.
 * @ac common/Dynamic/FactoryHolder.h Permissible
 */
export interface Permissible<T> {
  /** @ac common/Dynamic/FactoryHolder.h Permissible::Permit */
  permit(obj: T): number;
}
