import type { Capability } from '@mark/shared';
import type { CheckRunner, ValidationContext } from './context.js';

export interface ValidatorOutcome {
  accountInfo?: Record<string, unknown>;
  capabilities?: Capability[];
}

export type Validator = (ctx: ValidationContext, runner: CheckRunner) => Promise<ValidatorOutcome | void>;
