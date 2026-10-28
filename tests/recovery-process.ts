import { Store } from '../src/lib/store';
const [root, proposalId, point, expectedVersion] = process.argv.slice(2);
const store = new Store(root, current => { if (current === point) process.exit(73); });
store.approve(proposalId, Number(expectedVersion));
store.close();
