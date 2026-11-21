// The Worker's bindings, typed. Phase A reads none of the settler-only values (K, FUNDER_ADDRESS,
// GATE_GT_PASSED and the operator key secret); they are declared so the configuration is complete and the bundle
// assertion can hold the line on who may read them.
import type { MatcherMarket } from './market';
import type { MatcherSettler } from './settler';

export interface Env {
  MARKET: DurableObjectNamespace<MatcherMarket>;
  SETTLER: DurableObjectNamespace<MatcherSettler>;
  /// MakoOutcomeExchangeV1. Unset for this slice: every request is then answered 503 not_configured.
  EXCHANGE_ADDRESS?: string;
  CHAIN_ID: string;
  PUBLIC_RPC_URL: string;
  /// Settlement cap K. Phase B. Unset means the settler sends nothing.
  K?: string;
  /// MakoFunder. Phase B. Unset means the settler sends nothing.
  FUNDER_ADDRESS?: string;
  /// Exactly "true" after gate G-T passes. Phase B.
  GATE_GT_PASSED?: string;
  PRIMARY_RPC_URL?: string;
  OPERATOR_PRIVATE_KEY?: string;
  CANCEL_SECRET?: string;
}
