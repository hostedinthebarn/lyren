// Pairwise prioritization on NodeDb (contract/services.prioritize.contract.ts).

import { definePrioritizeContract } from './contract/services.prioritize.contract';
import { withNodeSpaceDb } from './services.fixtures';

definePrioritizeContract('node', withNodeSpaceDb);
