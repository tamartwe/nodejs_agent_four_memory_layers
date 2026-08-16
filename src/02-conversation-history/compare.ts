import { beforeRows } from './before';
import { afterRows } from './after';
import { printHistoryTable } from './conversation';
import { banner } from '../lib/report';

const TURN_COUNTS = [1, 5, 10, 25, 50, 75, 100];

banner('Demo 2 - conversation history comparison', null);
console.log(
  'Same complete transcript storage. Different prompt-building policy.\n',
);

printHistoryTable([
  ...beforeRows(TURN_COUNTS),
  ...afterRows(TURN_COUNTS),
]);

console.log(
  '\nBefore eventually overflows because stored turns == turns sent.'
    + '\nAfter stays below the context limit because stored turns != prompt turns.\n',
);
