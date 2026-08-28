/**
 * ClineAdapter — shape type for the Cline provider adapter.
 *
 * @module ClineAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ClineAdapterShape — per-instance Cline adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface ClineAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
