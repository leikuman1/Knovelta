import { dataDirectory, Store } from '../src/lib/store';

const store = new Store(dataDirectory());
try {
  if (store.recoveryErrors.length) {
    for (const message of store.recoveryErrors) console.error(message);
    process.exitCode = 1;
  } else console.info('恢复检查完成：已批准操作、正文和版本快照一致。');
} finally { store.close(); }
